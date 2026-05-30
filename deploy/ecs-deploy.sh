#!/bin/bash
set -euo pipefail

#=============================================================================
# Swifty Finance Platform (FinView) — ECS deployment
# Deploys to the existing "swifty-infra-cluster" with CodePipeline CI/CD.
# Domain: finview.swiftytechnologies.com
#
# Stateless service (all state lives in RDS Postgres) — no EFS.
# On ECS the Cognito Admin* calls authenticate via the task role, so the task
# role is granted cognito-idp Admin permissions on the user pool.
#
# Secrets are read from the environment (never hard-coded). Set before running:
#   FINVIEW_DATABASE_URL, FINVIEW_COGNITO_USER_POOL_ID,
#   FINVIEW_COGNITO_CLIENT_ID, FINVIEW_GATEWAY_API_KEY
#=============================================================================

AWS_REGION="eu-west-1"
CLUSTER_NAME="swifty-infra-cluster"
SERVICE_NAME="finview"
CONTAINER_NAME="finview"
ECR_REPO="swifty-finance-platform"
DOMAIN="finview.swiftytechnologies.com"
CONTAINER_PORT="3001"
GITHUB_OWNER="SwiftyTechnical"
GITHUB_REPO="swifty-finance-platform"
GITHUB_BRANCH="main"
COGNITO_POOL_ID_FOR_ARN="${FINVIEW_COGNITO_USER_POOL_ID:-eu-west-1_hZGBRl2th}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"  # repo root (Dockerfile lives here)

echo "========================================="
echo "FinView — ECS Deployment"
echo "========================================="

#-----------------------------------------------------------------------------
# Step 0: discover networking from an existing service in the cluster
#-----------------------------------------------------------------------------
echo ""; echo "[0] Discovering infrastructure from '${CLUSTER_NAME}'..."
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text --region ${AWS_REGION})
echo "  Account: ${ACCOUNT_ID}"

EXISTING_SERVICE=$(aws ecs list-services --cluster "${CLUSTER_NAME}" --region ${AWS_REGION} \
  --query 'serviceArns[0]' --output text)
[ "${EXISTING_SERVICE}" = "None" ] && { echo "  ERROR: no service to copy networking from"; exit 1; }

NETWORK_CONFIG=$(aws ecs describe-services --cluster "${CLUSTER_NAME}" --services "${EXISTING_SERVICE}" \
  --region ${AWS_REGION} --query 'services[0].networkConfiguration.awsvpcConfiguration')
SUBNET_IDS=$(echo "${NETWORK_CONFIG}" | python3 -c "import sys,json; print(','.join(json.load(sys.stdin)['subnets']))")
FIRST_SUBNET=$(echo "${SUBNET_IDS}" | cut -d',' -f1)
VPC_ID=$(aws ec2 describe-subnets --subnet-ids ${FIRST_SUBNET} --region ${AWS_REGION} \
  --query 'Subnets[0].VpcId' --output text)
PUBLIC_SUBNET_IDS=$(aws ec2 describe-subnets \
  --filters "Name=vpc-id,Values=${VPC_ID}" "Name=map-public-ip-on-launch,Values=true" \
  --region ${AWS_REGION} --query 'Subnets[].SubnetId' --output text | tr '\t' ',')
HOSTED_ZONE_ID=$(aws route53 list-hosted-zones-by-name --dns-name "swiftytechnologies.com" \
  --query 'HostedZones[?Name==`swiftytechnologies.com.`].Id' --output text | sed 's|/hostedzone/||')
echo "  VPC: ${VPC_ID}"
echo "  Private subnets: ${SUBNET_IDS}"
echo "  Public subnets:  ${PUBLIC_SUBNET_IDS}"
echo "  Hosted zone:     ${HOSTED_ZONE_ID}"

#-----------------------------------------------------------------------------
# Step 1: ECR repository
#-----------------------------------------------------------------------------
echo ""; echo "[1] ECR repository..."
aws ecr create-repository --repository-name ${ECR_REPO} --region ${AWS_REGION} \
  --image-scanning-configuration scanOnPush=true \
  --encryption-configuration encryptionType=AES256 2>/dev/null || echo "  exists."
ECR_URI="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO}"
echo "  ${ECR_URI}"

#-----------------------------------------------------------------------------
# Step 2: build & push the initial image (bootstrap so the service can start)
#-----------------------------------------------------------------------------
echo ""; echo "[2] Building & pushing initial image..."
aws ecr get-login-password --region ${AWS_REGION} | \
  docker login --username AWS --password-stdin ${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com
docker build -t ${ECR_URI}:latest "${SCRIPT_DIR}"
docker push ${ECR_URI}:latest
echo "  pushed ${ECR_URI}:latest"

#-----------------------------------------------------------------------------
# Step 3: CloudWatch log group
#-----------------------------------------------------------------------------
echo ""; echo "[3] Log group..."
aws logs create-log-group --log-group-name /ecs/finview --region ${AWS_REGION} 2>/dev/null || echo "  exists."
aws logs put-retention-policy --log-group-name /ecs/finview --retention-in-days 30 --region ${AWS_REGION}

#-----------------------------------------------------------------------------
# Step 4: SSM parameters (secrets) — only set if missing; values from env
#-----------------------------------------------------------------------------
echo ""; echo "[4] SSM parameters..."
put_secret() {
  local name="$1" val="$2"
  local existing
  existing=$(aws ssm get-parameter --name "/finview/${name}" --region ${AWS_REGION} \
    --query 'Parameter.Name' --output text 2>/dev/null || echo "")
  if [ -n "${existing}" ]; then echo "  /finview/${name} exists, skipping."; return; fi
  [ -z "${val}" ] && { echo "  WARN: no value for ${name} (set /finview/${name} later)"; return; }
  aws ssm put-parameter --name "/finview/${name}" --type SecureString --value "${val}" \
    --region ${AWS_REGION} --overwrite >/dev/null
  echo "  stored /finview/${name}"
}
put_secret DATABASE_URL          "${FINVIEW_DATABASE_URL:-}"
put_secret COGNITO_USER_POOL_ID  "${FINVIEW_COGNITO_USER_POOL_ID:-}"
put_secret COGNITO_CLIENT_ID     "${FINVIEW_COGNITO_CLIENT_ID:-}"
put_secret GATEWAY_API_KEY       "${FINVIEW_GATEWAY_API_KEY:-}"

#-----------------------------------------------------------------------------
# Step 5: Security groups (ALB + ECS task) — no EFS
#-----------------------------------------------------------------------------
echo ""; echo "[5] Security groups..."
get_or_create_sg() {
  local name="$1" desc="$2" id
  id=$(aws ec2 describe-security-groups \
    --filters "Name=group-name,Values=${name}" "Name=vpc-id,Values=${VPC_ID}" \
    --region ${AWS_REGION} --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || echo "None")
  if [ "${id}" = "None" ] || [ -z "${id}" ]; then
    id=$(aws ec2 create-security-group --group-name "${name}" --description "${desc}" \
      --vpc-id ${VPC_ID} --region ${AWS_REGION} --query 'GroupId' --output text)
  fi
  echo "${id}"
}
ALB_SG_ID=$(get_or_create_sg finview-alb-sg "ALB for FinView")
ECS_SG_ID=$(get_or_create_sg finview-ecs-sg "ECS tasks for FinView")
# ingress (idempotent — ignore duplicates)
aws ec2 authorize-security-group-ingress --group-id ${ALB_SG_ID} --protocol tcp --port 80  --cidr 0.0.0.0/0 --region ${AWS_REGION} 2>/dev/null || true
aws ec2 authorize-security-group-ingress --group-id ${ALB_SG_ID} --protocol tcp --port 443 --cidr 0.0.0.0/0 --region ${AWS_REGION} 2>/dev/null || true
aws ec2 authorize-security-group-ingress --group-id ${ECS_SG_ID} --protocol tcp --port ${CONTAINER_PORT} --source-group ${ALB_SG_ID} --region ${AWS_REGION} 2>/dev/null || true
echo "  ALB SG: ${ALB_SG_ID}  ECS SG: ${ECS_SG_ID}"

#-----------------------------------------------------------------------------
# Step 6: ACM certificate + Route53 DNS validation
#-----------------------------------------------------------------------------
echo ""; echo "[6] ACM certificate for ${DOMAIN}..."
CERT_ARN=$(aws acm list-certificates --region ${AWS_REGION} \
  --query "CertificateSummaryList[?DomainName=='${DOMAIN}'].CertificateArn" --output text 2>/dev/null || echo "")
if [ -z "${CERT_ARN}" ] || [ "${CERT_ARN}" = "None" ]; then
  CERT_ARN=$(aws acm request-certificate --domain-name ${DOMAIN} --validation-method DNS \
    --region ${AWS_REGION} --query 'CertificateArn' --output text)
  echo "  requested ${CERT_ARN}; waiting for validation record..."
  sleep 6
  VAL=$(aws acm describe-certificate --certificate-arn ${CERT_ARN} --region ${AWS_REGION} \
    --query 'Certificate.DomainValidationOptions[0].ResourceRecord')
  VN=$(echo "${VAL}" | python3 -c "import sys,json;print(json.load(sys.stdin)['Name'])")
  VV=$(echo "${VAL}" | python3 -c "import sys,json;print(json.load(sys.stdin)['Value'])")
  aws route53 change-resource-record-sets --hosted-zone-id ${HOSTED_ZONE_ID} --change-batch '{
    "Changes":[{"Action":"UPSERT","ResourceRecordSet":{"Name":"'"${VN}"'","Type":"CNAME","TTL":300,"ResourceRecords":[{"Value":"'"${VV}"'"}]}}]}' >/dev/null
  echo "  validation record created; waiting for ACM to validate..."
  aws acm wait certificate-validated --certificate-arn ${CERT_ARN} --region ${AWS_REGION}
  echo "  validated."
else
  echo "  exists: ${CERT_ARN}"
fi

#-----------------------------------------------------------------------------
# Step 7: ALB + target group + listeners
#-----------------------------------------------------------------------------
echo ""; echo "[7] ALB + target group + listeners..."
ALB_ARN=$(aws elbv2 describe-load-balancers --names finview-alb --region ${AWS_REGION} \
  --query 'LoadBalancers[0].LoadBalancerArn' --output text 2>/dev/null || echo "None")
if [ "${ALB_ARN}" = "None" ] || [ -z "${ALB_ARN}" ]; then
  ALB_ARN=$(aws elbv2 create-load-balancer --name finview-alb \
    --subnets $(echo ${PUBLIC_SUBNET_IDS} | tr ',' ' ') --security-groups ${ALB_SG_ID} \
    --scheme internet-facing --type application --region ${AWS_REGION} \
    --query 'LoadBalancers[0].LoadBalancerArn' --output text)
fi
ALB_DNS=$(aws elbv2 describe-load-balancers --load-balancer-arns ${ALB_ARN} --region ${AWS_REGION} --query 'LoadBalancers[0].DNSName' --output text)
ALB_ZONE_ID=$(aws elbv2 describe-load-balancers --load-balancer-arns ${ALB_ARN} --region ${AWS_REGION} --query 'LoadBalancers[0].CanonicalHostedZoneId' --output text)
echo "  ALB: ${ALB_DNS}"

TG_ARN=$(aws elbv2 describe-target-groups --names finview-tg --region ${AWS_REGION} \
  --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null || echo "None")
if [ "${TG_ARN}" = "None" ] || [ -z "${TG_ARN}" ]; then
  TG_ARN=$(aws elbv2 create-target-group --name finview-tg --protocol HTTP --port ${CONTAINER_PORT} \
    --vpc-id ${VPC_ID} --target-type ip --health-check-path /api/health \
    --health-check-interval-seconds 30 --healthy-threshold-count 2 --unhealthy-threshold-count 3 \
    --health-check-timeout-seconds 5 --region ${AWS_REGION} \
    --query 'TargetGroups[0].TargetGroupArn' --output text)
fi
echo "  TG: ${TG_ARN}"

LISTENER_PORTS=$(aws elbv2 describe-listeners --load-balancer-arn ${ALB_ARN} --region ${AWS_REGION} --query 'Listeners[].Port' --output text 2>/dev/null || echo "")
echo "${LISTENER_PORTS}" | grep -qw 80 || aws elbv2 create-listener --load-balancer-arn ${ALB_ARN} \
  --protocol HTTP --port 80 \
  --default-actions 'Type=redirect,RedirectConfig={Protocol=HTTPS,Port=443,StatusCode=HTTP_301}' \
  --region ${AWS_REGION} >/dev/null
echo "${LISTENER_PORTS}" | grep -qw 443 || aws elbv2 create-listener --load-balancer-arn ${ALB_ARN} \
  --protocol HTTPS --port 443 --certificates CertificateArn=${CERT_ARN} \
  --default-actions Type=forward,TargetGroupArn=${TG_ARN} \
  --ssl-policy ELBSecurityPolicy-TLS13-1-2-2021-06 --region ${AWS_REGION} >/dev/null
echo "  listeners ready (80→443 redirect, 443→TG)"

#-----------------------------------------------------------------------------
# Step 8: IAM roles (execution: SSM+ECR+logs; task: Cognito admin + ECS exec)
#-----------------------------------------------------------------------------
echo ""; echo "[8] IAM roles..."
TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]}'

aws iam create-role --role-name ecsTaskExecutionRole-finview --assume-role-policy-document "${TRUST}" 2>/dev/null || echo "  exec role exists."
aws iam attach-role-policy --role-name ecsTaskExecutionRole-finview \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy 2>/dev/null || true
aws iam put-role-policy --role-name ecsTaskExecutionRole-finview --policy-name SSMParameterAccess \
  --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["ssm:GetParameters","ssm:GetParameter"],"Resource":"arn:aws:ssm:'"${AWS_REGION}"':'"${ACCOUNT_ID}"':parameter/finview/*"}]}'

aws iam create-role --role-name ecsTaskRole-finview --assume-role-policy-document "${TRUST}" 2>/dev/null || echo "  task role exists."
aws iam put-role-policy --role-name ecsTaskRole-finview --policy-name CognitoAdminAuth \
  --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["cognito-idp:AdminInitiateAuth","cognito-idp:AdminRespondToAuthChallenge"],"Resource":"arn:aws:cognito-idp:'"${AWS_REGION}"':'"${ACCOUNT_ID}"':userpool/'"${COGNITO_POOL_ID_FOR_ARN}"'"}]}'
# allow ECS Exec (aws ecs execute-command) to attach to tasks
aws iam put-role-policy --role-name ecsTaskRole-finview --policy-name ECSExecSSM \
  --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["ssmmessages:CreateControlChannel","ssmmessages:CreateDataChannel","ssmmessages:OpenControlChannel","ssmmessages:OpenDataChannel"],"Resource":"*"}]}'
echo "  roles configured"
sleep 8  # let IAM propagate before ECS assumes the roles

#-----------------------------------------------------------------------------
# Step 9: register task definition
#-----------------------------------------------------------------------------
echo ""; echo "[9] Registering task definition..."
TASKDEF_TMP=$(mktemp)
sed "s|ACCOUNT_ID|${ACCOUNT_ID}|g; s|ECR_IMAGE_URI|${ECR_URI}:latest|g" \
  "${SCRIPT_DIR}/taskdef.json" > "${TASKDEF_TMP}"
aws ecs register-task-definition --cli-input-json "file://${TASKDEF_TMP}" --region ${AWS_REGION} >/dev/null
rm -f "${TASKDEF_TMP}"
echo "  registered: finview"

#-----------------------------------------------------------------------------
# Step 10: ECS service
#-----------------------------------------------------------------------------
echo ""; echo "[10] ECS service..."
STATUS=$(aws ecs describe-services --cluster "${CLUSTER_NAME}" --services ${SERVICE_NAME} --region ${AWS_REGION} \
  --query 'services[?status!=`INACTIVE`].status' --output text 2>/dev/null || echo "")
if [ -z "${STATUS}" ] || [ "${STATUS}" = "None" ]; then
  aws ecs create-service --cluster "${CLUSTER_NAME}" --service-name ${SERVICE_NAME} \
    --task-definition finview --desired-count 1 --launch-type FARGATE --platform-version 1.4.0 \
    --network-configuration "awsvpcConfiguration={subnets=[${SUBNET_IDS}],securityGroups=[${ECS_SG_ID}],assignPublicIp=DISABLED}" \
    --load-balancers "targetGroupArn=${TG_ARN},containerName=${CONTAINER_NAME},containerPort=${CONTAINER_PORT}" \
    --availability-zone-rebalancing DISABLED \
    --deployment-configuration "maximumPercent=200,minimumHealthyPercent=100,deploymentCircuitBreaker={enable=true,rollback=true}" \
    --enable-execute-command --region ${AWS_REGION} >/dev/null
  echo "  created service ${SERVICE_NAME}"
else
  aws ecs update-service --cluster "${CLUSTER_NAME}" --service ${SERVICE_NAME} \
    --task-definition finview --force-new-deployment --region ${AWS_REGION} >/dev/null
  echo "  updated service ${SERVICE_NAME}"
fi

#-----------------------------------------------------------------------------
# Step 11: Route53 A-alias → ALB
#-----------------------------------------------------------------------------
echo ""; echo "[11] DNS record ${DOMAIN} → ALB..."
aws route53 change-resource-record-sets --hosted-zone-id ${HOSTED_ZONE_ID} --change-batch '{
  "Changes":[{"Action":"UPSERT","ResourceRecordSet":{"Name":"'"${DOMAIN}"'","Type":"A",
    "AliasTarget":{"HostedZoneId":"'"${ALB_ZONE_ID}"'","DNSName":"'"${ALB_DNS}"'","EvaluateTargetHealth":true}}}]}' >/dev/null
echo "  ${DOMAIN} → ${ALB_DNS}"

#-----------------------------------------------------------------------------
# Step 12: CodePipeline (CodeBuild + pipeline, reusing the GitHub connection)
#-----------------------------------------------------------------------------
echo ""; echo "[12] CodePipeline..."
aws iam create-role --role-name codebuild-finview-role --assume-role-policy-document \
  '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"codebuild.amazonaws.com"},"Action":"sts:AssumeRole"}]}' 2>/dev/null || echo "  codebuild role exists."
aws iam put-role-policy --role-name codebuild-finview-role --policy-name CodeBuildPolicy --policy-document \
  '{"Version":"2012-10-17","Statement":[
    {"Effect":"Allow","Action":["logs:CreateLogGroup","logs:CreateLogStream","logs:PutLogEvents"],"Resource":"*"},
    {"Effect":"Allow","Action":["ecr:GetAuthorizationToken"],"Resource":"*"},
    {"Effect":"Allow","Action":["ecr:BatchCheckLayerAvailability","ecr:GetDownloadUrlForLayer","ecr:BatchGetImage","ecr:PutImage","ecr:InitiateLayerUpload","ecr:UploadLayerPart","ecr:CompleteLayerUpload"],"Resource":"arn:aws:ecr:'"${AWS_REGION}"':'"${ACCOUNT_ID}"':repository/'"${ECR_REPO}"'"},
    {"Effect":"Allow","Action":["s3:GetObject","s3:PutObject","s3:GetBucketAcl","s3:GetBucketLocation"],"Resource":"*"}]}'

aws codebuild create-project --name finview-build \
  --source type=CODEPIPELINE --artifacts type=CODEPIPELINE \
  --environment type=LINUX_CONTAINER,computeType=BUILD_GENERAL1_SMALL,image=aws/codebuild/amazonlinux2-x86_64-standard:5.0,privilegedMode=true \
  --service-role arn:aws:iam::${ACCOUNT_ID}:role/codebuild-finview-role --region ${AWS_REGION} 2>/dev/null || echo "  codebuild project exists."

CONNECTION_ARN=$(aws codestar-connections list-connections --provider-type-filter GitHub --region ${AWS_REGION} \
  --query "Connections[?ConnectionStatus=='AVAILABLE'].ConnectionArn | [0]" --output text)
[ -z "${CONNECTION_ARN}" ] || [ "${CONNECTION_ARN}" = "None" ] && { echo "  ERROR: no AVAILABLE GitHub connection"; exit 1; }
echo "  GitHub connection: ${CONNECTION_ARN}"

aws iam create-role --role-name codepipeline-finview-role --assume-role-policy-document \
  '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"codepipeline.amazonaws.com"},"Action":"sts:AssumeRole"}]}' 2>/dev/null || echo "  codepipeline role exists."
aws iam put-role-policy --role-name codepipeline-finview-role --policy-name CodePipelinePolicy --policy-document \
  '{"Version":"2012-10-17","Statement":[
    {"Effect":"Allow","Action":["s3:*"],"Resource":"*"},
    {"Effect":"Allow","Action":["codebuild:BatchGetBuilds","codebuild:StartBuild"],"Resource":"*"},
    {"Effect":"Allow","Action":["ecs:DescribeServices","ecs:DescribeTaskDefinition","ecs:DescribeTasks","ecs:ListTasks","ecs:RegisterTaskDefinition","ecs:UpdateService"],"Resource":"*"},
    {"Effect":"Allow","Action":["iam:PassRole"],"Resource":"*"},
    {"Effect":"Allow","Action":["codestar-connections:UseConnection"],"Resource":"'"${CONNECTION_ARN}"'"}]}'

ARTIFACT_BUCKET="finview-pipeline-${ACCOUNT_ID}"
aws s3 mb s3://${ARTIFACT_BUCKET} --region ${AWS_REGION} 2>/dev/null || echo "  artifact bucket exists."
sleep 8  # IAM propagation for the pipeline role

if aws codepipeline get-pipeline --name finview-pipeline --region ${AWS_REGION} >/dev/null 2>&1; then
  echo "  pipeline exists."
else
  aws codepipeline create-pipeline --region ${AWS_REGION} --pipeline '{
    "name":"finview-pipeline",
    "roleArn":"arn:aws:iam::'"${ACCOUNT_ID}"':role/codepipeline-finview-role",
    "artifactStore":{"type":"S3","location":"'"${ARTIFACT_BUCKET}"'"},
    "stages":[
      {"name":"Source","actions":[{"name":"GitHub","actionTypeId":{"category":"Source","owner":"AWS","provider":"CodeStarSourceConnection","version":"1"},"outputArtifacts":[{"name":"SourceOutput"}],"configuration":{"ConnectionArn":"'"${CONNECTION_ARN}"'","FullRepositoryId":"'"${GITHUB_OWNER}/${GITHUB_REPO}"'","BranchName":"'"${GITHUB_BRANCH}"'","OutputArtifactFormat":"CODE_ZIP"}}]},
      {"name":"Build","actions":[{"name":"DockerBuild","actionTypeId":{"category":"Build","owner":"AWS","provider":"CodeBuild","version":"1"},"inputArtifacts":[{"name":"SourceOutput"}],"outputArtifacts":[{"name":"BuildOutput"}],"configuration":{"ProjectName":"finview-build"}}]},
      {"name":"Deploy","actions":[{"name":"DeployToECS","actionTypeId":{"category":"Deploy","owner":"AWS","provider":"ECS","version":"1"},"inputArtifacts":[{"name":"BuildOutput"}],"configuration":{"ClusterName":"'"${CLUSTER_NAME}"'","ServiceName":"'"${SERVICE_NAME}"'","FileName":"imagedefinitions.json"}}]}
    ]}' >/dev/null
  echo "  created pipeline finview-pipeline"
fi

echo ""; echo "========================================="
echo "Done.  https://${DOMAIN}"
echo "  ALB:      ${ALB_DNS}"
echo "  Service:  ${CLUSTER_NAME}/${SERVICE_NAME}"
echo "  Pipeline: finview-pipeline"
echo "  Logs:     aws logs tail /ecs/finview --follow --region ${AWS_REGION}"
echo "========================================="
