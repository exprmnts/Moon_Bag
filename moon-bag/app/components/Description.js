export default function Description() {
  return (
    <div className="flex flex-col items-center justify-center space-y-6 text-center h-screen">
      {/* Moonbag Calculation - Main Focus */}
      <p className="text-[45px]  font-medium tracking-tighter text-neutral-900">
        With a 10% moonbag you would currently have 100ETH in $PEPE
      </p>
      <div className="w-1/4">
        <img src="/assets/pepe.jpeg" alt="Moonbag" className="w-full" />
      </div>
      {/* Initial Investment */}
      <p className="text-[20px] font-light tracking-tight text-neutral-900">
        You Bought 0.1 ETH Of $PEPE At 50k MC
      </p>

      {/* Exit Position */}
      <p className="text-[25px] font-light tracking-tight text-neutral-900">
        You Exit At 500k MC For A Profit Of 0.9ETH
      </p>

      {/* Paperhanded Amount */}
      <p className="text-[45px] font-medium tracking-tight text-neutral-900">
        You Paperhanded 2999.1ETH
      </p>

      {/* ATH Value */}
      <p className="text-[45px]  font-medium tracking-tight text-neutral-900">
        Your Moonbag At ATH Was Worth 300ETH
      </p>

      {/* Warning Message */}
      <p className="text-[65px]  font-medium tracking-tighter text-neutral-900">
        NEVER MAKE THAT MISTAKE AGAIN
      </p>

      {/* Mint Button */}
      <button className="rounded-full bg-black px-12 py-3 text-md font-medium text-white transition-colors hover:bg-black/90">
        MINT NFT
      </button>
    </div>
  );
}
