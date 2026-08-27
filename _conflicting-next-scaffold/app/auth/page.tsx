'use client'

import { FormEvent, useState } from 'react'
import { Heart, ArrowRight } from 'lucide-react'

export default function AuthPage() {
  const [mode, setMode] = useState<'login' | 'signup'>('signup')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const submit = (event: FormEvent) => {
    event.preventDefault()
    localStorage.setItem('kindly-auth', 'true')
    window.location.href = mode === 'signup' ? '/onboarding' : '/'
  }
  return <main className="auth-page"><div className="auth-card"><a className="onboarding-brand" href="/"><span className="brand-mark"><Heart size={19} fill="currentColor" /></span> Kindly</a><div className="auth-copy"><span className="eyebrow">A SOFTER START</span><h1>{mode === 'signup' ? 'Make more good days.' : 'Welcome back.'}</h1><p>{mode === 'signup' ? 'A private space to prepare, communicate, and connect with your child.' : 'Your family space is ready when you are.'}</p></div><form onSubmit={submit}><label htmlFor="auth-email">Email address</label><input id="auth-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="you@example.com" /><label htmlFor="auth-password">Password</label><input id="auth-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required placeholder="At least 8 characters" minLength={8} /><button className="button coral full" type="submit">{mode === 'signup' ? 'Create my space' : 'Sign in'} <ArrowRight size={17} /></button></form><button className="auth-switch" onClick={() => setMode(mode === 'signup' ? 'login' : 'signup')}>{mode === 'signup' ? 'Already have an account? Sign in' : 'New here? Create an account'}</button></div><div className="auth-art"><span className="eyebrow">KINDLY IS FOR</span><h2>Small moments that feel a little easier.</h2><p>Start with one situation. Build from there.</p></div></main>
}
