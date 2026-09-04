"use client";
import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { EASE_OUT, line } from "./variants";

const ITEMS = [
  {
    q: "Is my Private key safe?",
    a: "Yes, its only shown once, save it then, cause once its gone, its gone.",
  },
  { q: "Are there fees?", a: "1% of tokens from all trades." },
  {
    q: "Can I access without tokens?",
    a: "Yes, initially token holders will receive early access. Anyone can access the bot via a subscription.",
  },
  {
    q: "Why should I hold tokens?",
    a: "Token holders may be eligible to receive rewards from protocol treasury and revenue in the future.",
  },
  {
    q: "Is the token safe to invest?",
    a: "The $MOON token is for all intents and purposes a memecoin. We promise no guaranteed rewards or promise the price will go up. Please only speculate with money you can afford to lose.",
  },
];

// Same bones as How It Works: numbered rows, no rules. Each row expands.
export default function FAQ() {
  const [open, setOpen] = useState(null);

  return (
    <dl data-no-advance className="space-y-4 sm:space-y-5">
      {ITEMS.map((item, i) => {
        const isOpen = open === i;
        return (
          <motion.div key={item.q} variants={line}>
            <dt>
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => setOpen(isOpen ? null : i)}
                className="flex w-full items-baseline gap-5 text-left sm:gap-8"
              >
                <span className="t-label w-[2ch] shrink-0">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="t-md flex-1">{item.q}</span>
                <motion.span
                  aria-hidden
                  className="t-md inline-block font-mono font-light"
                  animate={{ rotate: isOpen ? 45 : 0 }}
                  transition={{ duration: 0.4, ease: EASE_OUT }}
                >
                  +
                </motion.span>
              </button>
            </dt>
            <AnimatePresence initial={false}>
              {isOpen && (
                <motion.dd
                  key="answer"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{
                    height: { duration: 0.45, ease: EASE_OUT },
                    opacity: { duration: 0.3 },
                  }}
                  className="overflow-hidden"
                >
                  <div className="flex gap-5 sm:gap-8">
                    <span aria-hidden className="w-[2ch] shrink-0" />
                    <motion.p
                      initial={{ y: 10 }}
                      animate={{ y: 0 }}
                      exit={{ y: 6 }}
                      transition={{ duration: 0.4, ease: EASE_OUT }}
                      className="t-sm max-w-2xl pb-1 pt-3 italic"
                    >
                      {item.a}
                    </motion.p>
                  </div>
                </motion.dd>
              )}
            </AnimatePresence>
          </motion.div>
        );
      })}
    </dl>
  );
}
