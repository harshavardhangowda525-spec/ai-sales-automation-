import { Composition } from 'remotion';
import { Reel, REEL_DURATION } from './Reel';

// 1080x1920 vertical, 30 fps. Reel.tsx exports its own length so each day's reel can differ.
export const RemotionRoot = () => (
  <Composition id="Reel" component={Reel} durationInFrames={REEL_DURATION} fps={30} width={1080} height={1920} />
);
