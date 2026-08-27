'use client'

import { useEffect, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, Heart, Sparkles } from 'lucide-react'

const steps = [
  { title: 'Let us get to know your child', detail: 'A few gentle details help Kindly feel more personal.' },
  { title: 'Choose what helps', detail: 'Pick the supports that make everyday moments easier.' },
  { title: 'You are ready', detail: 'We will use this to shape stories, routines, and requests.' },
]

const supports = ['Visual choices', 'Extra processing time', 'Quiet spaces', 'Deep pressure', 'Words', 'Pictures']

export default function OnboardingPage() {
  const [step, setStep] = useState(0)
  const [name, setName] = useState('')
  const [selected, setSelected] = useState<string[]>([])

  useEffect(() => {
    const saved = localStorage.getItem('kindly-profile')
    if (saved) {
      const profile = JSON.parse(saved) as { name?: string; selected?: string[] }
      setName(profile.name ?? '')
      setSelected(profile.selected ?? [])
    }
  }, [])

  const toggleSupport = (support: string) => {
    setSelected((current) => current.includes(support) ? current.filter((item) => item !== support) : [...current, support])
  }

  return (
    <main className="onboarding-page">
      <header className="onboarding-top">
        <a className="onboarding-brand" href="/"><span className="brand-mark"><Heart size={19} fill="currentColor" /></span> Kindly</a>
        <span className="onboarding-progress">Step {step + 1} of {steps.length}</span>
      </header>
      <div className="onboarding-layout">
        <aside className="onboarding-aside">
          <div className="onboarding-sun"><Sparkles size={24} /></div>
          <span className="eyebrow">A SOFTER START</span>
          <h1>Let&apos;s make more good days.</h1>
          <p>Kindly helps you prepare, communicate, and connect in ways that feel right for your family.</p>
          <div className="onboarding-steps" aria-label="Onboarding progress">
            {steps.map((item, index) => <div className={index === step ? 'onboarding-step current' : index < step ? 'onboarding-step done' : 'onboarding-step'} key={item.title}><span>{index < step ? <Check size={15} /> : index + 1}</span><div><b>{item.title}</b><small>{item.detail}</small></div></div>)}
          </div>
        </aside>
        <section className="onboarding-card" aria-labelledby="onboarding-title">
          {step === 0 && <div className="onboarding-form"><span className="eyebrow">FIRST, A LITTLE ABOUT YOU</span><h2 id="onboarding-title">Who are we supporting?</h2><p className="onboarding-copy">This helps us create a more familiar space. You can change anything later.</p><label htmlFor="child-name">Child&apos;s name</label><input id="child-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Child's name" autoComplete="off" /><div className="onboarding-note"><Heart size={17} fill="currentColor" /><span>We&apos;ll keep this space gentle, private, and yours.</span></div></div>}
          {step === 1 && <div className="onboarding-form"><span className="eyebrow">WHAT HELPS MOST</span><h2 id="onboarding-title">Choose a few supports.</h2><p className="onboarding-copy">There is no perfect answer. Start with what feels useful today.</p><div className="onboarding-options">{supports.map((support) => <button type="button" key={support} className={selected.includes(support) ? 'onboarding-option selected' : 'onboarding-option'} onClick={() => toggleSupport(support)}><span>{selected.includes(support) && <Check size={15} />}</span>{support}</button>)}</div></div>}
          {step === 2 && <div className="onboarding-form onboarding-complete"><div className="onboarding-completion-badge"><span className="onboarding-check"><Check size={22} /></span><span>YOU&apos;RE ALL SET</span></div><h2 id="onboarding-title">Welcome to your Kindly space, {name || 'friend'}.</h2><p className="onboarding-copy">We&apos;ll start with your chosen supports and learn what helps along the way.</p><a className="button coral onboarding-complete-cta" href="/">Go to my space <ArrowRight size={17} /></a></div>}
          {step < 2 && <div className="onboarding-actions"><button type="button" className="onboarding-back" onClick={() => setStep((current) => Math.max(0, current - 1))} disabled={step === 0}><ArrowLeft size={16} /> Previous</button><button type="button" className="button coral" onClick={() => { if (step === 1) localStorage.setItem('kindly-profile', JSON.stringify({ name, selected })); setStep((current) => current + 1) }}>{step === 0 ? 'Continue' : 'Finish setup'} <ArrowRight size={17} /></button></div>}
        </section>
      </div>
    </main>
  )
}
