import { Composition } from 'remotion';
import { loadFont as loadGeist } from '@remotion/google-fonts/Geist';
import { loadFont as loadGeistMono } from '@remotion/google-fonts/GeistMono';
import { SparkHermes } from './SparkHermes';
import { HermesAgent, AGENT_FPS, AGENT_TOTAL } from './HermesAgent';
import { TOTAL_FRAMES, FPS } from './theme';

loadGeist();
loadGeistMono();

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="SparkHermes"
        component={SparkHermes}
        durationInFrames={TOTAL_FRAMES}
        fps={FPS}
        width={1080}
        height={1920}
      />
      <Composition
        id="HermesAgent"
        component={HermesAgent}
        durationInFrames={AGENT_TOTAL}
        fps={AGENT_FPS}
        width={1080}
        height={1080}
      />
    </>
  );
};
