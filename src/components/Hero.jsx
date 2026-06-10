export default function Hero() {
  return (
    <section className="relative min-h-screen flex items-center justify-center overflow-hidden">
      <div className="absolute inset-0 bg-[#0f172a]" />
      <div className="absolute inset-0 bg-gradient-to-br from-[#1a2744] via-[#0f172a] to-[#0a0f1e]" />
      <div className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[700px] bg-[#f59e0b]/[0.06] rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-0 left-0 w-[400px] h-[400px] bg-[#1e40af]/10 rounded-full blur-3xl pointer-events-none" />

      <div className="relative z-10 text-center max-w-4xl mx-auto px-4 sm:px-6 pt-16">
        <img
          src="/images/GardenStateWildcardLogo-1.PNG"
          alt="Garden State Wildcard"
          className="h-28 sm:h-36 w-auto mx-auto mb-8 drop-shadow-2xl"
        />
        <h1 className="text-4xl sm:text-6xl lg:text-7xl font-black tracking-tight mb-6 leading-tight">
          New Jersey's Premier
          <span className="block text-[#f59e0b] mt-1">Sports Card Dealer</span>
        </h1>
        <p className="text-lg sm:text-xl text-gray-400 max-w-2xl mx-auto mb-10 leading-relaxed">
          We buy, sell, and source sports cards and memorabilia across New Jersey.
          Whether you're building your collection or ready to sell — we're your connection.
        </p>
        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <a
            href="#inquire"
            className="bg-[#f59e0b] text-[#0f172a] px-8 py-4 rounded font-bold text-lg hover:bg-[#fbbf24] transition-colors shadow-lg shadow-amber-500/20"
          >
            Inquire Now
          </a>
          <a
            href="#about"
            className="border border-white/20 text-white px-8 py-4 rounded font-semibold text-lg hover:border-[#f59e0b] hover:text-[#f59e0b] transition-colors"
          >
            Learn More
          </a>
        </div>
      </div>

      <div className="absolute bottom-8 left-1/2 -translate-x-1/2 animate-bounce">
        <svg className="w-6 h-6 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </div>
    </section>
  )
}
