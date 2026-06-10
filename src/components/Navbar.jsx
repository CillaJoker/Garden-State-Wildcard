import { useState, useEffect } from 'react'

const links = [
  { label: 'About', href: '#about' },
  { label: 'Services', href: '#services' },
  { label: 'Inquire', href: '#inquire' },
  { label: 'Contact', href: '#contact' },
]

export default function Navbar() {
  const [isOpen, setIsOpen] = useState(false)
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 20)
    window.addEventListener('scroll', handleScroll)
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  return (
    <nav className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${scrolled ? 'bg-[#0f172a]/95 backdrop-blur-sm shadow-lg shadow-black/20' : 'bg-transparent'}`}>
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          <a href="#" className="flex items-center gap-3">
            <img
              src="/images/GardenStateWildcardLogo-1.PNG"
              alt="Garden State Wildcard"
              className="h-10 w-auto"
            />
          </a>

          <div className="hidden md:flex items-center gap-8">
            {links.map(link => (
              <a
                key={link.href}
                href={link.href}
                className="text-gray-300 hover:text-[#f59e0b] transition-colors font-medium text-sm tracking-wide"
              >
                {link.label}
              </a>
            ))}
            <a
              href="#inquire"
              className="bg-[#f59e0b] text-[#0f172a] px-4 py-2 rounded font-bold text-sm hover:bg-[#fbbf24] transition-colors"
            >
              Get in Touch
            </a>
          </div>

          <button
            onClick={() => setIsOpen(!isOpen)}
            className="md:hidden p-2 text-gray-300 hover:text-white transition-colors"
            aria-label="Toggle menu"
          >
            {isOpen ? (
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            ) : (
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {isOpen && (
        <div className="md:hidden bg-[#0f172a] border-t border-white/10">
          <div className="px-4 py-4 flex flex-col gap-4">
            {links.map(link => (
              <a
                key={link.href}
                href={link.href}
                onClick={() => setIsOpen(false)}
                className="text-gray-300 hover:text-[#f59e0b] transition-colors font-medium py-1"
              >
                {link.label}
              </a>
            ))}
            <a
              href="#inquire"
              onClick={() => setIsOpen(false)}
              className="bg-[#f59e0b] text-[#0f172a] px-4 py-3 rounded font-bold text-center hover:bg-[#fbbf24] transition-colors"
            >
              Get in Touch
            </a>
          </div>
        </div>
      )}
    </nav>
  )
}
