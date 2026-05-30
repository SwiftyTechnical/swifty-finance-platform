import { useState, type FormEvent } from 'react'
import { useAuth } from './AuthContext'

const VIEWS = {
  LOGIN: 'login',
  NEW_PASSWORD: 'new_password',
  MFA_SETUP: 'mfa_setup',
  MFA_VERIFY: 'mfa_verify',
  FORGOT_PASSWORD: 'forgot_password',
  RESET_PASSWORD: 'reset_password',
  CHANGE_PASSWORD: 'change_password',
} as const

type View = (typeof VIEWS)[keyof typeof VIEWS]

function EyeIcon({ visible, onClick }: { visible: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className="password-toggle"
      onClick={onClick}
      tabIndex={-1}
      aria-label={visible ? 'Hide password' : 'Show password'}
    >
      {visible ? (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
          <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
          <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
          <line x1="1" y1="1" x2="23" y2="23" />
        </svg>
      ) : (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      )}
    </button>
  )
}

export default function Login() {
  const { login } = useAuth()

  const [view, setView] = useState<View>(VIEWS.LOGIN)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [totpCode, setTotpCode] = useState('')
  const [resetCode, setResetCode] = useState('')
  const [session, setSession] = useState<string | null>(null)
  const [secretCode, setSecretCode] = useState('')
  const [qrUri, setQrUri] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [showNewPassword, setShowNewPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)

  async function handleLogin(e: FormEvent) {
    e.preventDefault()
    setError('')
    setSubmitting(true)

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      const data = await res.json()

      if (!res.ok) {
        setError(data.error)
        return
      }

      if (data.authenticated) {
        login(data.tokens)
        return
      }

      if (data.challenge === 'NEW_PASSWORD_REQUIRED') {
        setSession(data.session)
        setView(VIEWS.NEW_PASSWORD)
        return
      }

      if (data.challenge === 'MFA_SETUP') {
        setSession(data.session)
        setSecretCode(data.secretCode)
        setQrUri(data.qrUri)
        setView(VIEWS.MFA_SETUP)
        return
      }

      if (data.challenge === 'SOFTWARE_TOKEN_MFA') {
        setSession(data.session)
        setView(VIEWS.MFA_VERIFY)
        return
      }

      setError(`Unexpected challenge: ${data.challenge}`)
    } catch {
      setError('Connection failed. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleNewPassword(e: FormEvent) {
    e.preventDefault()
    setError('')

    if (newPassword !== confirmPassword) {
      setError('Passwords do not match')
      return
    }

    setSubmitting(true)
    try {
      const res = await fetch('/api/auth/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          challengeName: 'NEW_PASSWORD_REQUIRED',
          session,
          responses: { email, newPassword },
        }),
      })
      const data = await res.json()

      if (!res.ok) {
        setError(data.error)
        return
      }

      if (data.authenticated) {
        login(data.tokens)
        return
      }

      if (data.challenge === 'MFA_SETUP') {
        setSession(data.session)
        setSecretCode(data.secretCode)
        setQrUri(data.qrUri)
        setView(VIEWS.MFA_SETUP)
        return
      }

      if (data.challenge === 'SOFTWARE_TOKEN_MFA') {
        setSession(data.session)
        setView(VIEWS.MFA_VERIFY)
        return
      }
    } catch {
      setError('Connection failed. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleMfaSetup(e: FormEvent) {
    e.preventDefault()
    setError('')
    setSubmitting(true)

    try {
      const res = await fetch('/api/auth/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          challengeName: 'MFA_SETUP',
          session,
          responses: { email, totpCode },
        }),
      })
      const data = await res.json()

      if (!res.ok) {
        setError(data.error)
        return
      }

      if (data.authenticated) {
        login(data.tokens)
        return
      }

      if (data.mfaSetupComplete) {
        setMessage('MFA setup complete. Please log in again.')
        setView(VIEWS.LOGIN)
        setPassword('')
        return
      }
    } catch {
      setError('Connection failed. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleMfaVerify(e: FormEvent) {
    e.preventDefault()
    setError('')
    setSubmitting(true)

    try {
      const res = await fetch('/api/auth/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          challengeName: 'SOFTWARE_TOKEN_MFA',
          session,
          responses: { email, totpCode },
        }),
      })
      const data = await res.json()

      if (!res.ok) {
        setError(data.error)
        return
      }

      if (data.authenticated) {
        login(data.tokens)
        return
      }
    } catch {
      setError('Connection failed. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleForgotPassword(e: FormEvent) {
    e.preventDefault()
    setError('')
    setSubmitting(true)

    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const data = await res.json()
      setMessage(data.message)
      setView(VIEWS.RESET_PASSWORD)
    } catch {
      setError('Connection failed. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleResetPassword(e: FormEvent) {
    e.preventDefault()
    setError('')

    if (newPassword !== confirmPassword) {
      setError('Passwords do not match')
      return
    }

    setSubmitting(true)
    try {
      const res = await fetch('/api/auth/confirm-forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code: resetCode, newPassword }),
      })
      const data = await res.json()

      if (!res.ok) {
        setError(data.error)
        return
      }

      setMessage('Password reset successful. Please log in.')
      setView(VIEWS.LOGIN)
      setPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } catch {
      setError('Connection failed. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="login-container">
      <div className="login-card">
        <div className="login-header">
          <h1>Swifty Finance</h1>
          <p className="login-header-subtitle">Sign in to finance platform</p>
        </div>

        {error && <div className="login-error">{error}</div>}
        {message && <div className="login-message">{message}</div>}

        {/* LOGIN */}
        {view === VIEWS.LOGIN && (
          <form onSubmit={handleLogin}>
            <div className="form-group">
              <label htmlFor="email">Email</label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                required
                autoFocus
              />
            </div>
            <div className="form-group">
              <label htmlFor="password">Password</label>
              <div className="password-input-wrapper">
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  required
                />
                <EyeIcon visible={showPassword} onClick={() => setShowPassword(!showPassword)} />
              </div>
            </div>
            <button type="submit" className="login-btn" disabled={submitting}>
              {submitting ? 'Signing in...' : 'Sign In'}
            </button>
            <button
              type="button"
              className="login-link"
              onClick={() => {
                setView(VIEWS.FORGOT_PASSWORD)
                setError('')
                setMessage('')
              }}
            >
              Forgot password?
            </button>
          </form>
        )}

        {/* NEW PASSWORD */}
        {view === VIEWS.NEW_PASSWORD && (
          <form onSubmit={handleNewPassword}>
            <p className="login-subtitle">You must set a new password to continue.</p>
            <div className="form-group">
              <label htmlFor="newPassword">New Password</label>
              <div className="password-input-wrapper">
                <input
                  id="newPassword"
                  type={showNewPassword ? 'text' : 'password'}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Min 12 chars, upper, lower, number, symbol"
                  required
                  autoFocus
                />
                <EyeIcon visible={showNewPassword} onClick={() => setShowNewPassword(!showNewPassword)} />
              </div>
            </div>
            <div className="form-group">
              <label htmlFor="confirmPassword">Confirm Password</label>
              <div className="password-input-wrapper">
                <input
                  id="confirmPassword"
                  type={showConfirmPassword ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Re-enter your new password"
                  required
                />
                <EyeIcon visible={showConfirmPassword} onClick={() => setShowConfirmPassword(!showConfirmPassword)} />
              </div>
            </div>
            <button type="submit" className="login-btn" disabled={submitting}>
              {submitting ? 'Setting password...' : 'Set Password'}
            </button>
          </form>
        )}

        {/* MFA SETUP */}
        {view === VIEWS.MFA_SETUP && (
          <form onSubmit={handleMfaSetup}>
            <p className="login-subtitle">
              Set up two-factor authentication. Scan this QR code with your authenticator app
              (Google Authenticator, Authy, etc).
            </p>
            <div className="mfa-setup">
              <div className="mfa-qr">
                <img
                  src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(qrUri)}`}
                  alt="QR Code"
                  width="200"
                  height="200"
                />
              </div>
              <div className="mfa-secret">
                <label>Manual entry key:</label>
                <code>{secretCode}</code>
              </div>
            </div>
            <div className="form-group">
              <label htmlFor="totpSetup">Verification Code</label>
              <input
                id="totpSetup"
                type="text"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                placeholder="Enter 6-digit code"
                required
                autoFocus
              />
            </div>
            <button type="submit" className="login-btn" disabled={submitting}>
              {submitting ? 'Verifying...' : 'Verify & Complete Setup'}
            </button>
          </form>
        )}

        {/* MFA VERIFY */}
        {view === VIEWS.MFA_VERIFY && (
          <form onSubmit={handleMfaVerify}>
            <p className="login-subtitle">Enter the 6-digit code from your authenticator app.</p>
            <div className="form-group">
              <label htmlFor="totpVerify">Authentication Code</label>
              <input
                id="totpVerify"
                type="text"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                placeholder="Enter 6-digit code"
                required
                autoFocus
              />
            </div>
            <button type="submit" className="login-btn" disabled={submitting}>
              {submitting ? 'Verifying...' : 'Verify'}
            </button>
          </form>
        )}

        {/* FORGOT PASSWORD */}
        {view === VIEWS.FORGOT_PASSWORD && (
          <form onSubmit={handleForgotPassword}>
            <p className="login-subtitle">Enter your email to receive a password reset code.</p>
            <div className="form-group">
              <label htmlFor="resetEmail">Email</label>
              <input
                id="resetEmail"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                required
                autoFocus
              />
            </div>
            <button type="submit" className="login-btn" disabled={submitting}>
              {submitting ? 'Sending...' : 'Send Reset Code'}
            </button>
            <button
              type="button"
              className="login-link"
              onClick={() => {
                setView(VIEWS.LOGIN)
                setError('')
                setMessage('')
              }}
            >
              Back to sign in
            </button>
          </form>
        )}

        {/* RESET PASSWORD */}
        {view === VIEWS.RESET_PASSWORD && (
          <form onSubmit={handleResetPassword}>
            <p className="login-subtitle">Enter the code sent to your email and your new password.</p>
            <div className="form-group">
              <label htmlFor="code">Reset Code</label>
              <input
                id="code"
                type="text"
                value={resetCode}
                onChange={(e) => setResetCode(e.target.value)}
                placeholder="Enter reset code"
                required
                autoFocus
              />
            </div>
            <div className="form-group">
              <label htmlFor="newPw">New Password</label>
              <div className="password-input-wrapper">
                <input
                  id="newPw"
                  type={showNewPassword ? 'text' : 'password'}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Min 12 chars, upper, lower, number, symbol"
                  required
                />
                <EyeIcon visible={showNewPassword} onClick={() => setShowNewPassword(!showNewPassword)} />
              </div>
            </div>
            <div className="form-group">
              <label htmlFor="confirmPw">Confirm Password</label>
              <div className="password-input-wrapper">
                <input
                  id="confirmPw"
                  type={showConfirmPassword ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Re-enter your new password"
                  required
                />
                <EyeIcon visible={showConfirmPassword} onClick={() => setShowConfirmPassword(!showConfirmPassword)} />
              </div>
            </div>
            <button type="submit" className="login-btn" disabled={submitting}>
              {submitting ? 'Resetting...' : 'Reset Password'}
            </button>
            <button
              type="button"
              className="login-link"
              onClick={() => {
                setView(VIEWS.LOGIN)
                setError('')
                setMessage('')
              }}
            >
              Back to sign in
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
