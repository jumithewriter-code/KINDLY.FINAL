'use client'

import { useEffect, useState } from 'react'
import {
  ArrowLeft, ArrowRight, Bell, BookOpen, Check, ChevronDown, CircleHelp, Clock3,
  Heart, Home, MessageCircle, MoreHorizontal, Play, Plus, Send, Settings2,
  Sparkles, UserRound, Users, X, Zap,
} from 'lucide-react'

const navItems = [
  { label: 'Home', icon: Home },
  { label: 'Stories', icon: BookOpen },
  { label: 'Requests', icon: MessageCircle },
  { label: 'Routines', icon: Clock3 },
  { label: 'Profile', icon: UserRound },
]

const situations = ['Doctor visit', 'School morning', 'New place', 'Bedtime', 'Something else']
const formats = ['Short story', 'Visual schedule', 'Practice together']
const requestTypes = [
  { label: 'Bathroom', detail: 'I need to go', color: 'yellow' },
  { label: 'Drink', detail: 'I am thirsty', color: 'blue' },
  { label: 'Break', detail: 'I need quiet', color: 'purple' },
  { label: 'Help', detail: 'Something is tricky', color: 'coral' },
]

function IconButton({ label, children, onClick }: { label: string; children: React.ReactNode; onClick?: () => void }) {
  return <button aria-label={label} onClick={onClick} className="icon-button">{children}</button>
}

function SectionTitle({ eyebrow, title, detail }: { eyebrow?: string; title: string; detail?: string }) {
  return <div className="section-title">{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h2>{title}</h2>{detail && <p>{detail}</p>}</div>
}

export default function Page() {
  const [active, setActive] = useState('Home')
  const [childMode, setChildMode] = useState(false)
  const [childScreen, setChildScreen] = useState<'home' | 'help' | 'sent'>('home')
  const [situation, setSituation] = useState('Doctor visit')
  const [format, setFormat] = useState('Short story')
  const [difficulty, setDifficulty] = useState('A little new')
  const [generated, setGenerated] = useState(false)
  const [bathroomPending, setBathroomPending] = useState(false)
  const [caregiverComing, setCaregiverComing] = useState(false)
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [profileName, setProfileName] = useState('')

  useEffect(() => {
    const saved = localStorage.getItem('kindly-profile')
    if (saved) setProfileName((JSON.parse(saved) as { name?: string }).name ?? '')
  }, [])

  const openChildMode = () => { setChildMode(true); setChildScreen('home') }
  const sendBathroom = () => { setBathroomPending(true); setChildScreen('sent') }

  if (childMode) return <ChildMode screen={childScreen} setScreen={setChildScreen} onExit={() => setChildMode(false)} pending={bathroomPending} coming={caregiverComing} />

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark"><Heart size={20} fill="currentColor" /></div><span>Kindly</span></div>
        <button className="profile-mini" onClick={() => setActive('Profile')} aria-label="Open profile"><div className="avatar">{profileName ? profileName.slice(0,1).toUpperCase() : 'A'}</div><div><strong>{profileName ? `${profileName}'s space` : 'Your space'}</strong><small>Caregiver view</small></div><ChevronDown size={15} /></button>
        <nav aria-label="Main navigation">{navItems.map(({ label, icon: Icon }) => <button key={label} className={active === label ? 'nav-item active' : 'nav-item'} onClick={() => setActive(label)} aria-label={label}><Icon size={19} /><span>{label}</span>{label === 'Requests' && bathroomPending && <b className="nav-badge">1</b>}<span className="nav-tooltip" role="tooltip">{label}</span></button>)}</nav>
        <div className="sidebar-bottom"><button className="nav-item" onClick={() => setActive('Settings')} aria-label="Settings"><Settings2 size={19} /><span>Settings</span><span className="nav-tooltip" role="tooltip">Settings</span></button><div className="made-for"><Sparkles size={16} /><span>Made for<br /><strong>more good days</strong></span></div></div>
      </aside>
      <section className="main-content">
        <header className="topbar"><div><span className="mobile-brand">Kindly</span><p className="date-label">Tuesday, October 15, 2024</p><h1>{active === 'Home' ? `Good morning${profileName ? `, ${profileName}` : ''}` : active}</h1></div><div className="top-actions"><div className="notification-wrap"><IconButton label="Notifications" onClick={() => setNotificationsOpen((open) => !open)}><Bell size={20} />{bathroomPending && <b className="notification-dot" />}</IconButton>{notificationsOpen && <div className="notification-popover" role="dialog" aria-label="Notifications"><b>Notifications</b><p>{bathroomPending ? 'Your child is asking for help with the bathroom.' : 'You are all caught up.'}</p>{generated && <p>Your new story is ready to read.</p>}<button className="text-button" onClick={() => setNotificationsOpen(false)}>Close</button></div>}</div><button className="avatar large profile-trigger" aria-label="Open profile" onClick={() => setActive('Profile')}>J</button></div></header>
        {active === 'Home' && <HomeView profileName={profileName} openChildMode={openChildMode} generated={generated} setGenerated={setGenerated} situation={situation} setSituation={setSituation} format={format} setFormat={setFormat} difficulty={difficulty} setDifficulty={setDifficulty} bathroomPending={bathroomPending} setActive={setActive} />}
        {active === 'Stories' && <StoriesView openChildMode={openChildMode} generated={generated} />}
        {active === 'Requests' && <RequestsView pending={bathroomPending} coming={caregiverComing} onComing={() => setCaregiverComing(true)} />}
        {active === 'Routines' && <SimpleView icon={<Clock3 />} title="A softer rhythm" detail="Create predictable routines that leave room for the day to change." items={['Morning check-in', 'Getting ready for school', 'Wind-down time']} />}
        {active === 'Profile' && <ProfileView />}
        {active === 'Settings' && <SettingsView />}
      </section>
    </main>
  )
}

function HomeView(props: any) {
  const { profileName, openChildMode, generated, setGenerated, situation, setSituation, format, setFormat, difficulty, setDifficulty, bathroomPending, setActive } = props
  return <div className="content-wrap">
    <div className="journey"><div className="journey-line" /><div className="journey-step done"><span><Check size={16} /></span><div><b>Prepare</b><small>Make a plan</small></div></div><div className="journey-step current"><span>2</span><div><b>Communicate</b><small>Find the words</small></div></div><div className="journey-step"><span>3</span><div><b>Connect</b><small>Feel understood</small></div></div></div>
    <div className="hero-grid"><div className="welcome-card"><span className="eyebrow">TODAY&apos;S LITTLE WIN</span><h2>Small steps count.</h2><p>One prepared moment can make the whole day feel easier.</p><button className="button coral" onClick={openChildMode}>Try child mode <ArrowRight size={17} /></button></div><div className="today-card"><div className="card-heading"><div><span className="eyebrow">UP NEXT</span><h3>Getting ready for school</h3></div><IconButton label="More options"><MoreHorizontal size={19} /></IconButton></div><div className="routine-row"><div className="routine-icon yellow-bg">☀</div><div><b>Morning check-in</b><small>Now · 3 steps</small></div><Play size={17} fill="currentColor" /></div><div className="routine-row"><div className="routine-icon blue-bg">◒</div><div><b>Pack my bag</b><small>8:30 AM · 5 steps</small></div><ChevronDown size={17} /></div></div></div>
    <div className="section-title split"><div><span className="eyebrow">YOUR TOOLKIT</span><h2>What would help today?</h2></div><button className="text-button" onClick={() => setActive('Stories')}>See all <ArrowRight size={16} /></button></div>
    <div className="tool-grid"><button className="tool-card peach" onClick={() => { window.location.href = '/situations' }}><div className="tool-art">✦</div><b>Prepare for a situation</b><span>Make a simple plan together</span></button><button className="tool-card lavender" onClick={openChildMode}><div className="tool-art">☁</div><b>Practice communication</b><span>Try words, pictures, or gestures</span></button><button className="tool-card mint" onClick={() => setActive('Routines')}><div className="tool-art">☼</div><b>Build a routine</b><span>Make the next step clearer</span></button></div>
    <div id="prepare" className="prepare-layout"><div className="prepare-form"><SectionTitle eyebrow="PREPARE TOGETHER" title="A little planning can help a lot." detail="Choose a situation and we&apos;ll make a gentle practice story." /><label>What are you getting ready for?</label><div className="chip-wrap">{situations.map(item => <button key={item} className={situation === item ? 'choice selected' : 'choice'} onClick={() => setSituation(item)}>{item}</button>)}</div><label>How new does this feel?</label><div className="chip-wrap">{['I know it well', 'A little new', 'Very new'].map(item => <button key={item} className={difficulty === item ? 'choice selected' : 'choice'} onClick={() => setDifficulty(item)}>{item}</button>)}</div><label>What would feel best?</label><div className="format-list">{formats.map(item => <button key={item} className={format === item ? 'format selected' : 'format'} onClick={() => setFormat(item)}><span className="radio" />{item}<small>{item === 'Short story' ? 'A few simple steps' : item === 'Visual schedule' ? 'See what comes next' : 'Try it side by side'}</small></button>)}</div><button className="button yellow" onClick={() => setGenerated(true)}><Sparkles size={17} /> Make my story</button></div><div className="story-preview">{generated ? <><div className="preview-top"><span className="eyebrow">ALEX&apos;S STORY</span><button className="close-preview" onClick={() => setGenerated(false)}><X size={17} /></button></div><div className="story-illustration">☀<span>✦</span></div><h3>Visiting a new place</h3><p>Sometimes a new place feels big. I can look, listen, and take one small step.</p><div className="story-controls"><button>←</button><span>1 of 4</span><button>→</button></div><button className="button coral full" onClick={openChildMode}>Preview child mode <ArrowRight size={17} /></button></> : <div className="empty-preview"><div className="preview-dots">✦</div><h3>Your story will appear here</h3><p>Pick a few options on the left, then make a story to practice together.</p></div>}</div></div>
    <div className="recent-header"><SectionTitle eyebrow="STAY CONNECTED" title="Recent requests" /><button className="text-button" onClick={() => setActive('Requests')}>View requests <ArrowRight size={16} /></button></div><div className="request-card"><div className="request-avatar">A</div><div><b>{bathroomPending ? 'Bathroom' : 'No new requests'}</b><p>{bathroomPending ? `${profileName || 'Your child'} is waiting for a response` : `When ${profileName || 'your child'} asks for help, it will show here.`}</p></div><span className={bathroomPending ? 'status waiting' : 'status quiet'}>{bathroomPending ? 'Waiting' : 'All quiet'}</span></div>
  </div>
}

function ChildMode({ screen, setScreen, onExit, pending, coming }: any) { return <main className="child-mode"><header className="child-top"><button className="child-exit" onClick={onExit}><ArrowLeft size={20} /> Adult View</button><div className="child-avatar">A</div></header>{screen === 'home' && <div className="child-home"><div className="child-greeting"><span className="eyebrow">TUESDAY</span><h1>Hi Alex!</h1><p>What would you like to do?</p></div><div className="child-cards"><button className="child-card yellow-card"><span>☀</span><b>My day</b><small>See what&apos;s next</small></button><button className="child-card blue-card"><span>☁</span><b>My stories</b><small>Practice together</small></button><button className="child-card coral-card" onClick={() => setScreen('help')}><span>♡</span><b>I need help</b><small>Ask for what you need</small></button><button className="child-card lavender-card"><span>◒</span><b>How I feel</b><small>Share my feelings</small></button></div><div className="child-footer"><span>Take your time.</span><button className="skip-button">Help <CircleHelp size={16} /></button></div></div>}{screen === 'help' && <div className="help-screen"><button className="back-link" onClick={() => setScreen('home')}><ArrowLeft size={17} /> Back</button><div className="child-greeting"><span className="eyebrow">I NEED HELP WITH...</span><h1>What do you need?</h1><p>Choose one. You can change your mind.</p></div><div className="help-grid">{requestTypes.map(item => <button key={item.label} className={`help-card ${item.color}`} onClick={() => item.label === 'Bathroom' ? setScreen('sent') : setScreen('sent')}><span>{item.label === 'Bathroom' ? '◒' : item.label === 'Drink' ? '◯' : item.label === 'Break' ? '☁' : '♡'}</span><b>{item.label}</b><small>{item.detail}</small></button>)}</div></div>}{screen === 'sent' && <div className="sent-screen"><div className="sent-icon">{coming ? <Check size={35} /> : <Clock3 size={35} />}</div><span className="eyebrow">{coming ? 'ON THE WAY' : 'REQUEST SENT'}</span><h1>{coming ? 'Jamie is coming.' : 'You asked for help.'}</h1><p>{coming ? 'You are not alone. Take a slow breath while you wait.' : 'Your grown-up knows. You can wait here or go back.'}</p><button className="button coral" onClick={() => setScreen('home')}>Back to my day <ArrowRight size={17} /></button></div>}</main> }

function StoriesView({ openChildMode, generated }: any) { return <div className="content-wrap"><SectionTitle eyebrow="ALEX&apos;S LIBRARY" title="Stories for everyday moments" detail="Short, gentle ways to make unfamiliar moments feel more familiar." /><div className="library-hero"><div><span className="eyebrow">FEATURED STORY</span><h2>{generated ? 'Visiting a new place' : 'A trip to the doctor'}</h2><p>Take it one step at a time. There is always a way to pause.</p><button className="button coral" onClick={openChildMode}><Play size={16} fill="currentColor" /> Read together</button></div><div className="large-art">☀</div></div><div className="story-list">{['A trip to the doctor', 'When plans change', 'Finding a quiet place'].map((x, i) => <div className="story-row" key={x}><div className={`story-thumb thumb-${i}`}>{i === 0 ? '♡' : i === 1 ? '↻' : '☁'}</div><div><b>{x}</b><small>{i + 3} pages · 2 min</small></div><ArrowRight size={17} /></div>)}</div></div> }

function RequestsView({ pending, coming, onComing }: any) { return <div className="content-wrap"><SectionTitle eyebrow="STAY CONNECTED" title="Requests" detail="A calm place to notice what Alex is communicating." />{pending ? <div className="inbox-card"><div className="request-avatar">A</div><div className="inbox-main"><div className="inbox-title"><b>Alex needs help</b><span className="status waiting">{coming ? 'Coming' : 'Waiting'}</span></div><h3>Bathroom</h3><p>Sent just now · Alex is waiting for a response</p><div className="inbox-actions"><button className="button coral" onClick={onComing}><Check size={16} /> I&apos;m coming</button><button className="button secondary">Not right now</button></div></div></div> : <div className="blank-state"><div className="blank-icon"><MessageCircle size={25} /></div><h3>All quiet for now</h3><p>New requests from Alex will appear here.</p></div>}</div> }
function SimpleView({ icon, title, detail, items }: any) { return <div className="content-wrap"><SectionTitle eyebrow="ROUTINES" title={title} detail={detail} /><div className="routine-list">{items.map((item: string, i: number) => <div className="routine-large" key={item}><div className="routine-icon yellow-bg">{icon}</div><div><b>{item}</b><small>{i === 0 ? 'Every weekday · 7:30 AM' : 'A gentle sequence of steps'}</small></div><ChevronDown size={18} /></div>)}<button className="button yellow" onClick={() => { window.location.href = '/routines' }}><Plus size={17} /> Add a routine</button></div></div> }
function SettingsView() { return <div className="content-wrap"><SectionTitle eyebrow="YOUR SPACE" title="Settings" detail="Keep Kindly feeling calm, private, and useful for your family." /><div className="settings-list"><div className="settings-row"><div><b>Notifications</b><small>Stay updated when stories finish and requests arrive.</small></div><span className="status quiet">On</span></div><div className="settings-row"><div><b>Child mode</b><small>Use the simple communication view from the Home page.</small></div><span className="status quiet">Ready</span></div><div className="settings-row"><div><b>Reset local space</b><small>Clear this demo profile and start onboarding again.</small></div><button className="button secondary" onClick={() => { localStorage.clear(); window.location.href='/auth' }}>Reset</button></div></div></div> }
function ProfileView() { return <div className="content-wrap"><SectionTitle eyebrow="ALEX&apos;S PROFILE" title="What helps Alex feel safe" detail="These preferences are here to guide every little moment." /><div className="profile-card"><div className="profile-banner"><div className="avatar profile-avatar">A</div><div><h2>Alex</h2><p>Curious, thoughtful, and growing every day.</p></div><button className="button secondary">Edit profile</button></div><div className="preference-grid"><div><span className="eyebrow">SENSORY PREFERENCES</span><h3>Things that help</h3><div className="preference-tags"><span>Quiet spaces</span><span>Visual choices</span><span>Extra processing time</span><span>Deep pressure</span></div></div><div><span className="eyebrow">COMMUNICATION</span><h3>Alex&apos;s ways</h3><div className="preference-tags"><span>Words</span><span>Pictures</span><span>Gestures</span></div></div></div></div></div> }
