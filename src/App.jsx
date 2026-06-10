import Navbar from './components/Navbar'
import Hero from './components/Hero'
import About from './components/About'
import Services from './components/Services'
import InquiryForm from './components/InquiryForm'
import Contact from './components/Contact'
import Footer from './components/Footer'

export default function App() {
  return (
    <div className="bg-[#0f172a] text-white font-sans">
      <Navbar />
      <Hero />
      <About />
      <Services />
      <InquiryForm />
      <Contact />
      <Footer />
    </div>
  )
}
