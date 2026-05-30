import { Router } from 'express'
import { CognitoJwtVerifier } from 'aws-jwt-verify'
import {
  CognitoIdentityProviderClient,
  AdminInitiateAuthCommand,
  AdminRespondToAuthChallengeCommand,
  AssociateSoftwareTokenCommand,
  VerifySoftwareTokenCommand,
  ForgotPasswordCommand,
  ConfirmForgotPasswordCommand,
  ChangePasswordCommand,
  GlobalSignOutCommand,
} from '@aws-sdk/client-cognito-identity-provider'

// ---------------------------------------------------------------------------
// JWT verification middleware
// ---------------------------------------------------------------------------

let verifier = null

function getVerifier() {
  if (!verifier) {
    verifier = CognitoJwtVerifier.create({
      userPoolId: process.env.COGNITO_USER_POOL_ID,
      tokenUse: 'access',
      clientId: process.env.COGNITO_CLIENT_ID,
    })
  }
  return verifier
}

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' })
  }

  const token = header.slice(7)

  try {
    const payload = await getVerifier().verify(token)
    req.user = {
      sub: payload.sub,
      email: payload.username || payload.sub,
      groups: payload['cognito:groups'] || [],
    }
    next()
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }
}

export function requireGroup(groupName) {
  return (req, res, next) => {
    if (!req.user?.groups?.includes(groupName)) {
      return res.status(403).json({ error: 'Insufficient permissions' })
    }
    next()
  }
}

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------

export const authRouter = Router()

const cognito = new CognitoIdentityProviderClient({
  region: process.env.AWS_REGION || 'eu-west-1',
})

function poolId() {
  return process.env.COGNITO_USER_POOL_ID
}
function clientId() {
  return process.env.COGNITO_CLIENT_ID
}

// POST /auth/login
authRouter.post('/login', async (req, res) => {
  const { email, password } = req.body
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' })
  }

  try {
    const result = await cognito.send(
      new AdminInitiateAuthCommand({
        UserPoolId: poolId(),
        ClientId: clientId(),
        AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
        AuthParameters: {
          USERNAME: email,
          PASSWORD: password,
        },
      })
    )

    if (result.AuthenticationResult) {
      return res.json({
        authenticated: true,
        tokens: {
          accessToken: result.AuthenticationResult.AccessToken,
          idToken: result.AuthenticationResult.IdToken,
          refreshToken: result.AuthenticationResult.RefreshToken,
          expiresIn: result.AuthenticationResult.ExpiresIn,
        },
      })
    }

    if (result.ChallengeName === 'NEW_PASSWORD_REQUIRED') {
      return res.json({
        challenge: 'NEW_PASSWORD_REQUIRED',
        session: result.Session,
      })
    }

    if (result.ChallengeName === 'MFA_SETUP') {
      const tokenResult = await cognito.send(
        new AssociateSoftwareTokenCommand({
          Session: result.Session,
        })
      )

      const secret = tokenResult.SecretCode
      const qrUri = `otpauth://totp/SwiftyFinance:${email}?secret=${secret}&issuer=SwiftyFinance`

      return res.json({
        challenge: 'MFA_SETUP',
        session: tokenResult.Session,
        secretCode: secret,
        qrUri,
      })
    }

    if (result.ChallengeName === 'SOFTWARE_TOKEN_MFA') {
      return res.json({
        challenge: 'SOFTWARE_TOKEN_MFA',
        session: result.Session,
      })
    }

    return res.json({ challenge: result.ChallengeName, session: result.Session })
  } catch (err) {
    const status = err.name === 'NotAuthorizedException' ? 401 : 400
    return res.status(status).json({ error: err.message })
  }
})

// POST /auth/challenge
authRouter.post('/challenge', async (req, res) => {
  const { challengeName, session, responses } = req.body

  try {
    if (challengeName === 'NEW_PASSWORD_REQUIRED') {
      const result = await cognito.send(
        new AdminRespondToAuthChallengeCommand({
          UserPoolId: poolId(),
          ClientId: clientId(),
          ChallengeName: 'NEW_PASSWORD_REQUIRED',
          Session: session,
          ChallengeResponses: {
            USERNAME: responses.email,
            NEW_PASSWORD: responses.newPassword,
          },
        })
      )

      if (result.ChallengeName === 'MFA_SETUP') {
        const tokenResult = await cognito.send(
          new AssociateSoftwareTokenCommand({
            Session: result.Session,
          })
        )

        const secret = tokenResult.SecretCode
        const qrUri = `otpauth://totp/SwiftyFinance:${responses.email}?secret=${secret}&issuer=SwiftyFinance`

        return res.json({
          challenge: 'MFA_SETUP',
          session: tokenResult.Session,
          secretCode: secret,
          qrUri,
        })
      }

      if (result.AuthenticationResult) {
        return res.json({
          authenticated: true,
          tokens: {
            accessToken: result.AuthenticationResult.AccessToken,
            idToken: result.AuthenticationResult.IdToken,
            refreshToken: result.AuthenticationResult.RefreshToken,
            expiresIn: result.AuthenticationResult.ExpiresIn,
          },
        })
      }

      return res.json({ challenge: result.ChallengeName, session: result.Session })
    }

    if (challengeName === 'MFA_SETUP') {
      const verifyResult = await cognito.send(
        new VerifySoftwareTokenCommand({
          Session: session,
          UserCode: responses.totpCode,
          FriendlyDeviceName: 'authenticator',
        })
      )

      if (verifyResult.Status === 'SUCCESS') {
        if (verifyResult.Session) {
          const authResult = await cognito.send(
            new AdminRespondToAuthChallengeCommand({
              UserPoolId: poolId(),
              ClientId: clientId(),
              ChallengeName: 'MFA_SETUP',
              Session: verifyResult.Session,
              ChallengeResponses: {
                USERNAME: responses.email,
              },
            })
          )

          if (authResult.AuthenticationResult) {
            return res.json({
              authenticated: true,
              tokens: {
                accessToken: authResult.AuthenticationResult.AccessToken,
                idToken: authResult.AuthenticationResult.IdToken,
                refreshToken: authResult.AuthenticationResult.RefreshToken,
                expiresIn: authResult.AuthenticationResult.ExpiresIn,
              },
            })
          }

          return res.json({
            challenge: authResult.ChallengeName,
            session: authResult.Session,
          })
        }

        return res.json({ mfaSetupComplete: true })
      }

      return res.status(400).json({ error: 'MFA verification failed' })
    }

    if (challengeName === 'SOFTWARE_TOKEN_MFA') {
      const result = await cognito.send(
        new AdminRespondToAuthChallengeCommand({
          UserPoolId: poolId(),
          ClientId: clientId(),
          ChallengeName: 'SOFTWARE_TOKEN_MFA',
          Session: session,
          ChallengeResponses: {
            USERNAME: responses.email,
            SOFTWARE_TOKEN_MFA_CODE: responses.totpCode,
          },
        })
      )

      if (result.AuthenticationResult) {
        return res.json({
          authenticated: true,
          tokens: {
            accessToken: result.AuthenticationResult.AccessToken,
            idToken: result.AuthenticationResult.IdToken,
            refreshToken: result.AuthenticationResult.RefreshToken,
            expiresIn: result.AuthenticationResult.ExpiresIn,
          },
        })
      }

      return res.json({ challenge: result.ChallengeName, session: result.Session })
    }

    return res.status(400).json({ error: `Unknown challenge: ${challengeName}` })
  } catch (err) {
    return res.status(400).json({ error: err.message })
  }
})

// POST /auth/forgot-password
authRouter.post('/forgot-password', async (req, res) => {
  const { email } = req.body
  if (!email) return res.status(400).json({ error: 'Email is required' })

  try {
    await cognito.send(
      new ForgotPasswordCommand({
        ClientId: clientId(),
        Username: email,
      })
    )
    res.json({ message: 'If an account exists, a reset code has been sent.' })
  } catch {
    res.json({ message: 'If an account exists, a reset code has been sent.' })
  }
})

// POST /auth/confirm-forgot-password
authRouter.post('/confirm-forgot-password', async (req, res) => {
  const { email, code, newPassword } = req.body
  if (!email || !code || !newPassword) {
    return res.status(400).json({ error: 'Email, code, and new password are required' })
  }

  try {
    await cognito.send(
      new ConfirmForgotPasswordCommand({
        ClientId: clientId(),
        Username: email,
        ConfirmationCode: code,
        Password: newPassword,
      })
    )
    res.json({ message: 'Password reset successful' })
  } catch (err) {
    return res.status(400).json({ error: err.message })
  }
})

// POST /auth/change-password
authRouter.post('/change-password', async (req, res) => {
  const { accessToken, previousPassword, newPassword } = req.body
  if (!accessToken || !previousPassword || !newPassword) {
    return res
      .status(400)
      .json({ error: 'Access token, previous password, and new password are required' })
  }

  try {
    await cognito.send(
      new ChangePasswordCommand({
        AccessToken: accessToken,
        PreviousPassword: previousPassword,
        ProposedPassword: newPassword,
      })
    )
    res.json({ message: 'Password changed successfully' })
  } catch (err) {
    return res.status(400).json({ error: err.message })
  }
})

// POST /auth/refresh
authRouter.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body
  if (!refreshToken) return res.status(400).json({ error: 'Refresh token is required' })

  try {
    const result = await cognito.send(
      new AdminInitiateAuthCommand({
        UserPoolId: poolId(),
        ClientId: clientId(),
        AuthFlow: 'REFRESH_TOKEN_AUTH',
        AuthParameters: {
          REFRESH_TOKEN: refreshToken,
        },
      })
    )

    res.json({
      tokens: {
        accessToken: result.AuthenticationResult.AccessToken,
        idToken: result.AuthenticationResult.IdToken,
        expiresIn: result.AuthenticationResult.ExpiresIn,
      },
    })
  } catch (err) {
    return res.status(401).json({ error: 'Invalid refresh token' })
  }
})

// POST /auth/logout
authRouter.post('/logout', async (req, res) => {
  const { accessToken } = req.body
  if (!accessToken) return res.status(400).json({ error: 'Access token is required' })

  try {
    await cognito.send(
      new GlobalSignOutCommand({
        AccessToken: accessToken,
      })
    )
    res.json({ message: 'Logged out successfully' })
  } catch {
    res.json({ message: 'Logged out' })
  }
})
