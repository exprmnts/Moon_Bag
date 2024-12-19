import Link from "next/link";
import Description from "./components/Description";

export default function Page() {
  return (
    <main className="min-h-screen bg-white">
      <div className="container mx-auto px-4">
        {/* Header */}
        <header className="flex items-center justify-between py-8">
          <Link href="/" className="text-2xl font-black tracking-tighter">
            MOONBAG EXT
          </Link>
          <button className="rounded-full bg-black px-8 py-3 text-sm font-medium text-white transition-colors hover:bg-black/90">
            CONNECT
          </button>
        </header>

        {/* Hero Section */}
        <section className="flex min-h-[80vh] flex-col items-center justify-center text-center">
          <h1 className="mb-6 text-4xl font-black tracking-tight sm:text-6xl md:text-7xl lg:text-8xl">
            NEVER FORGET THE MOONBAG
          </h1>
          <p className="max-w-3xl text-xl font-light tracking-tight text-neutral-800 sm:text-2xl md:text-3xl">
            A Trading Module That Will Always Leave A Moonbag For You.
          </p>
        </section>

        {/* Content Section with Moon Image and Calculator */}
        <section className="flex flex-row items-center justify-between py-8">
          {/* Left Side - Moon Image */}
          <div className="w-1/3">
            <img src="/assets/moon.jpeg" alt="Moonbag" className="w-full animate-spin [animation-duration:55s]" />
          </div>

          {/* Right Side - Calculator */}
          <div className="w-1/2">
            <div className="flex flex-col space-y-6">
              <h2 className="text-xl font-light tracking-tight text-neutral-800 sm:text-2xl md:text-3xl">
                Check how much generational wealth you have paperhanded
              </h2>
              <button className="self-start rounded-full border-2 border-black bg-white px-8 py-3 text-sm font-medium text-black transition-colors hover:bg-black hover:text-white">
                PAPERHAND CALCULATOR
              </button>
            </div>
          </div>
        </section>

        {/* Mint Section */}
        <section className="flex min-h-[50vh] flex-col items-center justify-center space-y-8 py-2">
          <div className="flex flex-col items-center space-y-8">
            <h2 className="max-w-3xl text-xl font-light tracking-tight text-neutral-800 sm:text-2xl md:text-4xl">
              Or skip the pain and just mint man!
            </h2>
            <button className="rounded-full bg-black px-12 py-3 text-md font-medium text-white transition-colors hover:bg-black/90">
              MINT NFT
            </button>
          </div>
        </section>
        <Description />
      </div>
    </main>
  );
}
