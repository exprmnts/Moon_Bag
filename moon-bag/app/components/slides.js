"use client";
import { motion } from "motion/react";
import { group, line } from "./variants";
import BracketButton from "./BracketButton";
import Chart from "./Chart";
import FAQ from "./FAQ";

// Word-by-word reveal. Each word is a line-variant child of a faster group.
function Words({ text, as: Tag = "p", className = "", stagger = 0.05 }) {
  const MotionTag = motion[Tag];
  return (
    <MotionTag variants={group(stagger)} className={className}>
      {text.split(" ").map((word, i) => (
        <span key={i}>
          <motion.span variants={line} className="inline-block">
            {word}
          </motion.span>{" "}
        </span>
      ))}
    </MotionTag>
  );
}

const P = ({ className = "", children }) => (
  <motion.p variants={line} className={className}>
    {children}
  </motion.p>
);

// One column for the single-column slides, so 5, 6, 7 and 8 share a layout.
const Column = ({ children }) => (
  <div className="mx-auto w-full max-w-3xl">{children}</div>
);

/* 1 ─ DID YOU LEAVE A MOONBAG? */
function Hero({ onCta }) {
  return (
    <div className="flex min-h-[55svh] flex-col justify-between gap-16">
      <Words
        as="h1"
        text="DID YOU LEAVE A MOONBAG?"
        className="t-hero max-w-[12ch] font-normal uppercase"
        stagger={0.08}
      />
      <P className="t-md self-end text-right">
        Click here for paperhand calculator →{" "}
        <BracketButton onClick={onCta}>Button</BracketButton>
      </P>
    </div>
  );
}

/* 2 ─ the calculator */
function Joke() {
  return (
    <div className="mx-auto max-w-5xl text-center">
      <Words
        text="Nah we won’t do that to you lol, you know the ones you missed already if you’ve made it this far"
        className="t-xl"
        stagger={0.06}
      />
    </div>
  );
}

/* 3 ─ chart + research */
function Research() {
  return (
    <div className="mx-auto grid w-full max-w-6xl items-center gap-12 md:grid-cols-2 md:gap-16">
      <Chart />
      <div className="space-y-6 md:space-y-8">
        <P className="t-md">
          Research shows 90% trenchers after 2 years of experience inevitably
          always capture the 10000x opportunities.
        </P>
        <P className="t-md">However, but most never hodl.</P>
        <P className="t-md">
          The curse of being early: when you buy things super early; sub 100k or
          1mil, your targets aren’t high enough because you don’t believe you
          can win big.
        </P>
        <P className="t-lg italic">Moonbag fixes this.</P>
      </div>
    </div>
  );
}

/* 4 ─ what a moon bag is (same column and sizes as slides 5 and 7) */
function Definition() {
  return (
    <Column>
      <div className="space-y-4 sm:space-y-5">
        <P className="t-lg">
          A moon bag is the % of your original bag you leave in, with the
          intention of it going to the moon or to dust.
        </P>
        <P className="t-md">
          Everyone knows about it. <em>Only the pros do it.</em>
        </P>
        <P className="t-md">
          Because it’s hard. You need money to keep gambling, so you sell the
          things that run. Then lose it in a rug.
        </P>
        <P className="t-md">
          We all know hundreds of people who sold $Pepe, $Pnut and $PONS early.
        </P>
      </div>
      <div className="mt-12 space-y-4 sm:mt-16 sm:space-y-5">
        <P className="t-lg">Don’t be that guy.</P>
        <P className="t-md italic">
          You only need one win to retire your bloodline.
        </P>
      </div>
    </Column>
  );
}

/* 5 ─ $MOON */
function Token() {
  return (
    <Column>
      <div className="space-y-4 sm:space-y-5">
        <P className="t-lg">$MOON launched on Pons.</P>
        <P className="t-md">Team holds 20% of supply, locked for 6 months.</P>
        <P className="t-md">Early access, hold 1% $MOON</P>
      </div>
      <div className="mt-12 space-y-4 sm:mt-16 sm:space-y-5">
        <P className="t-label">Revenue</P>
        <P className="t-md">1% transaction fee on all trades</P>
        <P className="t-md">1% of the moonbag when you profit</P>
      </div>
    </Column>
  );
}

/* 6 ─ How It Works */
const STEPS = [
  "Connect account and verify token holdings",
  "Set up account",
  "Fund account",
  "Config thresholds",
  "Give wallet address to track trades",
  "Moonbag Bot will reverse copy trade your sell all trades",
];

function HowItWorks() {
  return (
    <Column>
      <P className="t-label mb-8 sm:mb-10">How It Works</P>
      <ol className="space-y-4 sm:space-y-5">
        {STEPS.map((step, i) => (
          <motion.li
            key={step}
            variants={line}
            className="flex items-baseline gap-5 sm:gap-8"
          >
            <span className="t-label w-[2ch] shrink-0">
              {String(i + 1).padStart(2, "0")}
            </span>
            <span className="t-md">{step}</span>
          </motion.li>
        ))}
      </ol>
    </Column>
  );
}

/* 7 ─ the promise */
function Promise() {
  return (
    <Column>
      <div className="space-y-4 sm:space-y-5">
        <P className="t-lg">Moonbag Bot will ensure you always leave the moonbag.</P>
        <P className="t-md">Cause you cannot sell, until your targets are hit.</P>
        <P className="t-md italic">
          It’s a single purpose bot built for a very specific use case.
        </P>
      </div>
    </Column>
  );
}

/* 8 ─ FAQ */
function Faq() {
  return (
    <Column>
      <P className="t-label mb-8 sm:mb-10">FAQ</P>
      <FAQ />
    </Column>
  );
}

export const SLIDES = [
  { id: "hero", component: Hero },
  // Hidden: never reached by scrolling, only revealed by the hero button.
  { id: "joke", component: Joke, hidden: true },
  { id: "research", component: Research },
  { id: "definition", component: Definition },
  { id: "token", component: Token },
  { id: "how", component: HowItWorks },
  { id: "promise", component: Promise },
  { id: "faq", component: Faq },
];
