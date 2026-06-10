const services = [
  {
    title: 'We Buy',
    description: 'Looking to sell your collection? We purchase singles, lots, and full collections across all sports. Fair market offers with fast turnaround — no lowballing.',
    icon: (
      <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
  {
    title: 'We Sell',
    description: 'Browse our inventory of graded slabs, raw cards, and sports memorabilia. Reach out to inquire about availability — new inventory added regularly.',
    icon: (
      <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
      </svg>
    ),
  },
  {
    title: 'Card Shows & Events',
    description: 'Find us at local NJ card shows and collector events. Come meet us in person, browse the table, and talk cards. Follow us on Instagram for show announcements.',
    icon: (
      <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
  },
]

export default function Services() {
  return (
    <section id="services" className="py-24 px-4 sm:px-6 bg-[#0a1120]">
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-16">
          <p className="text-[#f59e0b] font-semibold text-sm tracking-widest uppercase mb-4">What We Do</p>
          <h2 className="text-3xl sm:text-5xl font-black">Our Services</h2>
        </div>

        <div className="grid md:grid-cols-3 gap-6">
          {services.map((service) => (
            <div
              key={service.title}
              className="bg-white/5 border border-white/10 rounded-2xl p-8 hover:border-[#f59e0b]/40 hover:bg-white/[0.07] transition-all duration-300 group"
            >
              <div className="text-[#f59e0b] mb-5 group-hover:scale-110 transition-transform duration-300 w-fit">
                {service.icon}
              </div>
              <h3 className="text-xl font-bold mb-3">{service.title}</h3>
              <p className="text-gray-400 leading-relaxed">{service.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
