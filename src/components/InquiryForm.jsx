import { useState } from 'react'

const FORMSPREE_ENDPOINT = 'https://formspree.io/f/mlgklzor'

const initialForm = {
  name: '',
  email: '',
  phone: '',
  player: '',
  year: '',
  set: '',
  grade: '',
  message: '',
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE_RE = /^[\+]?[(]?[0-9]{3}[)]?[-\s\.]?[0-9]{3}[-\s\.]?[0-9]{4,6}$/

function getErrors(form) {
  const errors = {}
  if (form.name.trim().length < 2) errors.name = 'Please enter your full name'
  if (!EMAIL_RE.test(form.email.trim())) errors.email = 'Please enter a valid email address'
  if (form.phone.trim() && !PHONE_RE.test(form.phone.trim())) errors.phone = 'Please enter a valid phone number'
  return errors
}

export default function InquiryForm() {
  const [status, setStatus] = useState('idle')
  const [form, setForm] = useState(initialForm)
  const [touched, setTouched] = useState({})

  const errors = getErrors(form)
  const isValid = Object.keys(errors).length === 0

  const handleChange = (e) => {
    setForm(prev => ({ ...prev, [e.target.name]: e.target.value }))
  }

  const handleBlur = (e) => {
    setTouched(prev => ({ ...prev, [e.target.name]: true }))
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setTouched({ name: true, email: true, phone: true })
    if (!isValid) return
    setStatus('loading')
    try {
      const res = await fetch(FORMSPREE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(form),
      })
      setStatus(res.ok ? 'success' : 'error')
      if (res.ok) {
        setForm(initialForm)
        setTouched({})
      }
    } catch {
      setStatus('error')
    }
  }

  const inputClass = (name) =>
    `w-full bg-white/5 border rounded-lg px-4 py-3 text-white placeholder-gray-600 focus:outline-none transition-colors ${
      touched[name] && errors[name]
        ? 'border-red-500/70 focus:border-red-500'
        : 'border-white/10 focus:border-[#f59e0b]/50'
    }`

  const baseInputClass =
    'w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white placeholder-gray-600 focus:outline-none focus:border-[#f59e0b]/50 transition-colors'

  return (
    <section id="inquire" className="py-24 px-4 sm:px-6 bg-[#0f172a]">
      <div className="max-w-2xl mx-auto">
        <div className="text-center mb-12">
          <p className="text-[#f59e0b] font-semibold text-sm tracking-widest uppercase mb-4">Get in Touch</p>
          <h2 className="text-3xl sm:text-5xl font-black mb-4">Interested in a Card?</h2>
          <p className="text-gray-400 text-lg">Tell us what you're looking for and we'll get back to you.</p>
        </div>

        {status === 'success' ? (
          <div className="bg-green-500/10 border border-green-500/30 rounded-2xl p-10 text-center">
            <div className="text-green-400 text-4xl mb-4">✓</div>
            <h3 className="text-xl font-bold text-green-400 mb-2">Message Sent!</h3>
            <p className="text-gray-400">We'll be in touch soon. Follow us on Instagram for the latest inventory.</p>
            <button
              onClick={() => setStatus('idle')}
              className="mt-6 text-[#f59e0b] hover:underline text-sm"
            >
              Send another message
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="bg-white/5 border border-white/10 rounded-2xl p-8 space-y-6">
            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-400 mb-2">
                  Name <span className="text-[#f59e0b]">*</span>
                </label>
                <input
                  type="text" name="name" value={form.name}
                  onChange={handleChange} onBlur={handleBlur}
                  placeholder="Your name" className={inputClass('name')}
                />
                {touched.name && errors.name && (
                  <p className="mt-1.5 text-red-400 text-xs">{errors.name}</p>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-400 mb-2">
                  Email <span className="text-[#f59e0b]">*</span>
                </label>
                <input
                  type="email" name="email" value={form.email}
                  onChange={handleChange} onBlur={handleBlur}
                  placeholder="your@email.com" className={inputClass('email')}
                />
                {touched.email && errors.email && (
                  <p className="mt-1.5 text-red-400 text-xs">{errors.email}</p>
                )}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-400 mb-2">
                Phone <span className="text-gray-600 text-xs">(optional)</span>
              </label>
              <input
                type="tel" name="phone" value={form.phone}
                onChange={handleChange} onBlur={handleBlur}
                placeholder="(555) 555-5555" className={inputClass('phone')}
              />
              {touched.phone && errors.phone && (
                <p className="mt-1.5 text-red-400 text-xs">{errors.phone}</p>
              )}
            </div>

            <div>
              <p className="text-sm font-medium text-gray-400 mb-3">
                Card Details <span className="text-gray-600 text-xs">(if applicable)</span>
              </p>
              <div className="grid sm:grid-cols-2 gap-4">
                <input
                  type="text" name="player" value={form.player} onChange={handleChange}
                  placeholder="Player" className={baseInputClass}
                />
                <input
                  type="text" name="year" value={form.year} onChange={handleChange}
                  placeholder="Year" className={baseInputClass}
                />
                <input
                  type="text" name="set" value={form.set} onChange={handleChange}
                  placeholder="Set / Brand" className={baseInputClass}
                />
                <input
                  type="text" name="grade" value={form.grade} onChange={handleChange}
                  placeholder="Grade / Condition" className={baseInputClass}
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-400 mb-2">Message</label>
              <textarea
                name="message" rows={4} value={form.message} onChange={handleChange}
                placeholder="Tell us what you're looking for, or anything else we should know..."
                className={`${baseInputClass} resize-none`}
              />
            </div>

            {status === 'error' && (
              <p className="text-red-400 text-sm">
                Something went wrong. Please try again or email us directly at gardenstatewildcard@gmail.com.
              </p>
            )}

            <button
              type="submit"
              disabled={!isValid || status === 'loading'}
              className="w-full bg-[#f59e0b] text-[#0f172a] font-bold py-4 rounded-lg text-lg transition-all shadow-lg shadow-amber-500/20 enabled:hover:bg-[#fbbf24] disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {status === 'loading' ? 'Sending...' : 'Send Inquiry'}
            </button>
          </form>
        )}
      </div>
    </section>
  )
}
