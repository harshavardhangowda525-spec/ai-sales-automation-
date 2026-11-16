// Default reel (fallback). Claude rewrites this file every day with a fresh, fully coded reel.
import { AbsoluteFill, Sequence, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { loadFont } from '@remotion/google-fonts/Sora';
import { BRAND } from './brand';

const { fontFamily } = loadFont('normal', { weights: ['400', '800'], subsets: ['latin'] });
export const REEL_DURATION = 30 * 18; // 18 s

const C = BRAND.colors;

const Bg = () => {
  const f = useCurrentFrame();
  const a = interpolate(f, [0, REEL_DURATION], [0, 360]);
  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <AbsoluteFill style={{ background: `radial-gradient(circle at ${50 + 30 * Math.cos((a * Math.PI) / 180)}% ${40 + 20 * Math.sin((a * Math.PI) / 180)}%, ${C.accent}55, transparent 55%), radial-gradient(circle at 80% 85%, ${C.accent2}40, transparent 50%)` }} />
      <AbsoluteFill style={{ opacity: 0.07, backgroundImage: 'repeating-linear-gradient(0deg, #fff 0 1px, transparent 1px 3px)' }} />
    </AbsoluteFill>
  );
};

const Pop = ({ children, delay = 0, y = 60 }: { children: React.ReactNode; delay?: number; y?: number }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: f - delay, fps, config: { damping: 14, mass: 0.6 } });
  return <div style={{ opacity: s, transform: `translateY(${(1 - s) * y}px) scale(${0.92 + 0.08 * s})` }}>{children}</div>;
};

const Title = ({ text, color = C.text, size = 110 }: { text: string; color?: string; size?: number }) => (
  <div style={{ fontFamily, fontWeight: 800, fontSize: size, lineHeight: 1.05, color, letterSpacing: -2 }}>{text}</div>
);

export const Reel = () => (
  <AbsoluteFill style={{ fontFamily, color: C.text }}>
    <Bg />
    <Sequence durationInFrames={120}>
      <AbsoluteFill style={{ padding: 90, justifyContent: 'center' }}>
        <Pop><Title text="Your customers" /></Pop>
        <Pop delay={8}><Title text="Google you first." color={C.accent2} /></Pop>
        <Pop delay={20}><div style={{ fontSize: 48, color: C.muted, marginTop: 40 }}>No website = they call your competitor.</div></Pop>
      </AbsoluteFill>
    </Sequence>
    <Sequence from={120} durationInFrames={210}>
      <AbsoluteFill style={{ padding: 80, justifyContent: 'center', gap: 34 }}>
        <Pop><Title text="Websites from" size={80} /></Pop>
        {BRAND.plans.map((p, i) => (
          <Pop key={p.name} delay={10 + i * 12}>
            <div style={{ background: `${C.panel}cc`, border: `2px solid ${C.accent}66`, borderRadius: 36, padding: '34px 40px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 56, fontWeight: 800 }}>
                <span>{p.name}</span><span style={{ color: C.accent2 }}>{p.price}</span>
              </div>
              <div style={{ fontSize: 34, color: C.muted, marginTop: 10 }}>{p.what}</div>
            </div>
          </Pop>
        ))}
      </AbsoluteFill>
    </Sequence>
    <Sequence from={330}>
      <AbsoluteFill style={{ padding: 90, justifyContent: 'center', alignItems: 'center', textAlign: 'center' }}>
        <Pop><Title text="Free 15-min consultation" size={88} /></Pop>
        <Pop delay={12}><div style={{ marginTop: 50, fontSize: 60, fontWeight: 800, background: C.accent, borderRadius: 999, padding: '28px 60px' }}>WhatsApp {BRAND.whatsapp}</div></Pop>
        <Pop delay={24}><div style={{ marginTop: 40, fontSize: 40, color: C.muted }}>{BRAND.name} · {BRAND.city}</div></Pop>
      </AbsoluteFill>
    </Sequence>
  </AbsoluteFill>
);
