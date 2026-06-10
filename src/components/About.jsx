const highlights = [
  { value: 'NJ Based', label: 'Garden State Proud' },
  { value: 'All Sports', label: 'NFL · NBA · MLB · NHL' },
  { value: 'Buy & Sell', label: 'Singles to Full Collections' },
]

export default function About() {
  return (
    <section id="about" className="py-24 px-4 sm:px-6 bg-[#0f172a]">
      <div className="max-w-6xl mx-auto">
        <div className="grid lg:grid-cols-2 gap-16 items-center">
          <div>
            <p className="text-[#f59e0b] font-semibold text-sm tracking-widest uppercase mb-4">About Us</p>
            <h2 className="text-3xl sm:text-5xl font-black mb-6 leading-tight">
              Collectors Serving
              <span className="block text-[#f59e0b]">Collectors</span>
            </h2>
            <p className="text-gray-400 text-lg leading-relaxed mb-5">
              Garden State Wildcard is a New Jersey-based sports card and memorabilia business built by collectors, for collectors. We specialize in buying and selling cards across all major sports — from vintage gems to modern hits.
            </p>
            <p className="text-gray-400 text-lg leading-relaxed">
              Whether you're looking to add a graded slab to your collection, sell off duplicates, or find us at a local card show — no middlemen, no hassle. Just passion for the hobby.
            </p>
          </div>

          <div className="flex flex-col gap-4">
            {highlights.map((item) => (
              <div
                key={item.label}
                className="bg-white/5 border border-white/10 rounded-xl p-6 flex items-center gap-6 hover:border-[#f59e0b]/30 transition-colors"
              >
                <div className="text-[#f59e0b] text-xl font-black w-28 shrink-0">{item.value}</div>
                <div className="text-gray-400 font-medium">{item.label}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
