import { AbsoluteFill, Audio, Sequence, staticFile } from 'remotion';
import { AgentIntro } from './scenes/agent/AgentIntro';
import { AgentTask } from './scenes/agent/AgentTask';
import { AgentLoop } from './scenes/agent/AgentLoop';
import { AgentShip } from './scenes/agent/AgentShip';
import { AgentApprove } from './scenes/agent/AgentApprove';
import { AgentOutro } from './scenes/agent/AgentOutro';

// 30s @ 30fps = 900 frames. Square 1080x1080.
export const AGENT_FPS = 30;
export const AGENT_TOTAL = 900;

const SCENES = {
  intro: { start: 0, dur: 135 },
  task: { start: 135, dur: 150 },
  loop: { start: 285, dur: 220 },
  ship: { start: 505, dur: 145 },
  approve: { start: 650, dur: 140 },
  outro: { start: 790, dur: 110 },
};

// Voiceover placement (absolute frame each segment starts at).
const VO = [
  { src: 'audio/agent/01_intro.mp3', at: 15 },
  { src: 'audio/agent/02_task.mp3', at: 150 },
  { src: 'audio/agent/03_loop.mp3', at: 300 },
  { src: 'audio/agent/04_ship.mp3', at: 515 },
  { src: 'audio/agent/05_approve.mp3', at: 658 },
  { src: 'audio/agent/06_outro.mp3', at: 800 },
];

export const HermesAgent: React.FC = () => {
  return (
    <AbsoluteFill style={{ background: '#0B0D12' }}>
      <Sequence from={SCENES.intro.start} durationInFrames={SCENES.intro.dur}>
        <AgentIntro />
      </Sequence>
      <Sequence from={SCENES.task.start} durationInFrames={SCENES.task.dur}>
        <AgentTask />
      </Sequence>
      <Sequence from={SCENES.loop.start} durationInFrames={SCENES.loop.dur}>
        <AgentLoop />
      </Sequence>
      <Sequence from={SCENES.ship.start} durationInFrames={SCENES.ship.dur}>
        <AgentShip />
      </Sequence>
      <Sequence from={SCENES.approve.start} durationInFrames={SCENES.approve.dur}>
        <AgentApprove />
      </Sequence>
      <Sequence from={SCENES.outro.start} durationInFrames={SCENES.outro.dur}>
        <AgentOutro />
      </Sequence>

      {VO.map((v) => (
        <Sequence key={v.src} from={v.at}>
          <Audio src={staticFile(v.src)} volume={1} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
