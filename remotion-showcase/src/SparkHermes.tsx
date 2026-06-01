import { AbsoluteFill, Audio, Sequence, staticFile } from 'remotion';
import { SCENES, VO } from './theme';
import { IntroScene } from './scenes/IntroScene';
import { OverviewScene } from './scenes/OverviewScene';
import { UsageScene } from './scenes/UsageScene';
import { ChartsScene } from './scenes/ChartsScene';
import { ChatsScene } from './scenes/ChatsScene';
import { OutroScene } from './scenes/OutroScene';

export const SparkHermes: React.FC = () => {
  return (
    <AbsoluteFill style={{ background: '#0B0D12' }}>
      <Sequence from={SCENES.intro.start} durationInFrames={SCENES.intro.dur}>
        <IntroScene />
      </Sequence>
      <Sequence from={SCENES.overview.start} durationInFrames={SCENES.overview.dur}>
        <OverviewScene />
      </Sequence>
      <Sequence from={SCENES.usage.start} durationInFrames={SCENES.usage.dur}>
        <UsageScene />
      </Sequence>
      <Sequence from={SCENES.charts.start} durationInFrames={SCENES.charts.dur}>
        <ChartsScene />
      </Sequence>
      <Sequence from={SCENES.chats.start} durationInFrames={SCENES.chats.dur}>
        <ChatsScene />
      </Sequence>
      <Sequence from={SCENES.outro.start} durationInFrames={SCENES.outro.dur}>
        <OutroScene />
      </Sequence>

      {/* Voiceover segments (no background music) */}
      {VO.map((v) => (
        <Sequence key={v.src} from={v.at}>
          <Audio src={staticFile(v.src)} volume={1} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
