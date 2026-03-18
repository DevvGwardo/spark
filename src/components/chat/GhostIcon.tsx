import React from 'react';

const ghostStyles = `
.ghost-icon {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  overflow: visible;
}

.ghost-icon .ghost-inner {
  position: absolute;
  top: 50%;
  left: 50%;
  transform-origin: center center;
}

.ghost-icon .ghost-body {
  animation: ghost-upNDown infinite 0.5s;
  position: relative;
  width: 140px;
  height: 140px;
  display: grid;
  grid-template-columns: repeat(14, 1fr);
  grid-template-rows: repeat(14, 1fr);
  grid-column-gap: 0px;
  grid-row-gap: 0px;
  grid-template-areas:
    "a1  a2  a3  a4  a5  top0  top0  top0  top0  a10 a11 a12 a13 a14"
    "b1  b2  b3  top1 top1 top1 top1 top1 top1 top1 top1 b12 b13 b14"
    "c1 c2 top2 top2 top2 top2 top2 top2 top2 top2 top2 top2 c13 c14"
    "d1 top3 top3 top3 top3 top3 top3 top3 top3 top3 top3 top3 top3 d14"
    "e1 top3 top3 top3 top3 top3 top3 top3 top3 top3 top3 top3 top3 e14"
    "f1 top3 top3 top3 top3 top3 top3 top3 top3 top3 top3 top3 top3 f14"
    "top4 top4 top4 top4 top4 top4 top4 top4 top4 top4 top4 top4 top4 top4"
    "top4 top4 top4 top4 top4 top4 top4 top4 top4 top4 top4 top4 top4 top4"
    "top4 top4 top4 top4 top4 top4 top4 top4 top4 top4 top4 top4 top4 top4"
    "top4 top4 top4 top4 top4 top4 top4 top4 top4 top4 top4 top4 top4 top4"
    "top4 top4 top4 top4 top4 top4 top4 top4 top4 top4 top4 top4 top4 top4"
    "top4 top4 top4 top4 top4 top4 top4 top4 top4 top4 top4 top4 top4 top4"
    "st0 st0 an4 st1 an7 st2 an10x an10x st3 an13 st4 an16 st5 st5"
    "an1 an2 an3 an5 an6 an8 an9 an9 an11 an12 an14 an15 an17 an18";
}

@keyframes ghost-upNDown {
  0%, 49% { transform: translateY(0px); }
  50%, 100% { transform: translateY(-10px); }
}

.ghost-body [data-g="top0"] { grid-area: top0; }
.ghost-body [data-g="top1"] { grid-area: top1; }
.ghost-body [data-g="top2"] { grid-area: top2; }
.ghost-body [data-g="top3"] { grid-area: top3; }
.ghost-body [data-g="top4"] { grid-area: top4; }
.ghost-body [data-g="st0"] { grid-area: st0; }
.ghost-body [data-g="st1"] { grid-area: st1; }
.ghost-body [data-g="st2"] { grid-area: st2; }
.ghost-body [data-g="st3"] { grid-area: st3; }
.ghost-body [data-g="st4"] { grid-area: st4; }
.ghost-body [data-g="st5"] { grid-area: st5; }

.ghost-body [data-g="top0"],
.ghost-body [data-g="top1"],
.ghost-body [data-g="top2"],
.ghost-body [data-g="top3"],
.ghost-body [data-g="top4"],
.ghost-body [data-g="st0"],
.ghost-body [data-g="st1"],
.ghost-body [data-g="st2"],
.ghost-body [data-g="st3"],
.ghost-body [data-g="st4"],
.ghost-body [data-g="st5"] {
  background-color: red;
}

.ghost-body [data-g="an1"] { grid-area: an1; animation: ghost-flicker0 infinite 0.5s; }
.ghost-body [data-g="an18"] { grid-area: an18; animation: ghost-flicker0 infinite 0.5s; }
.ghost-body [data-g="an2"] { grid-area: an2; animation: ghost-flicker1 infinite 0.5s; }
.ghost-body [data-g="an17"] { grid-area: an17; animation: ghost-flicker1 infinite 0.5s; }
.ghost-body [data-g="an3"] { grid-area: an3; animation: ghost-flicker1 infinite 0.5s; }
.ghost-body [data-g="an16"] { grid-area: an16; animation: ghost-flicker1 infinite 0.5s; }
.ghost-body [data-g="an4"] { grid-area: an4; animation: ghost-flicker1 infinite 0.5s; }
.ghost-body [data-g="an15"] { grid-area: an15; animation: ghost-flicker1 infinite 0.5s; }
.ghost-body [data-g="an6"] { grid-area: an6; animation: ghost-flicker0 infinite 0.5s; }
.ghost-body [data-g="an12"] { grid-area: an12; animation: ghost-flicker0 infinite 0.5s; }
.ghost-body [data-g="an7"] { grid-area: an7; animation: ghost-flicker0 infinite 0.5s; }
.ghost-body [data-g="an13"] { grid-area: an13; animation: ghost-flicker0 infinite 0.5s; }
.ghost-body [data-g="an9"] { grid-area: an9; animation: ghost-flicker1 infinite 0.5s; }
.ghost-body [data-g="an10x"] { grid-area: an10x; animation: ghost-flicker1 infinite 0.5s; }
.ghost-body [data-g="an8"] { grid-area: an8; animation: ghost-flicker0 infinite 0.5s; }
.ghost-body [data-g="an11"] { grid-area: an11; animation: ghost-flicker0 infinite 0.5s; }
.ghost-body [data-g="an5"] { grid-area: an5; animation: ghost-flicker0 infinite 0.5s; }
.ghost-body [data-g="an14"] { grid-area: an14; animation: ghost-flicker0 infinite 0.5s; }

@keyframes ghost-flicker0 {
  0%, 49% { background-color: red; }
  50%, 100% { background-color: transparent; }
}

@keyframes ghost-flicker1 {
  0%, 49% { background-color: transparent; }
  50%, 100% { background-color: red; }
}

.ghost-body .ghost-eye {
  width: 40px;
  height: 50px;
  position: absolute;
  top: 30px;
}

.ghost-body .ghost-eye-left { left: 10px; }
.ghost-body .ghost-eye-right { right: 30px; }

.ghost-body .ghost-eye::before {
  content: "";
  background-color: white;
  width: 20px;
  height: 50px;
  transform: translateX(10px);
  display: block;
  position: absolute;
}

.ghost-body .ghost-eye::after {
  content: "";
  background-color: white;
  width: 40px;
  height: 30px;
  transform: translateY(10px);
  display: block;
  position: absolute;
}

.ghost-body .ghost-pupil {
  width: 20px;
  height: 20px;
  background-color: #6A6A6A;
  position: absolute;
  top: 50px;
  z-index: 1;
  animation: ghost-eyesMovement infinite 3s;
}

.ghost-body .ghost-pupil-left { left: 10px; }
.ghost-body .ghost-pupil-right { right: 50px; }

@keyframes ghost-eyesMovement {
  0%, 49% { transform: translateX(0px); }
  50%, 99% { transform: translateX(10px); }
  100% { transform: translateX(0px); }
}
`;

interface GhostIconProps {
  size?: number; // px, defaults to 14
}

export const GhostIcon: React.FC<GhostIconProps> = ({ size = 14 }) => {
  const scale = size / 140;
  return (
    <>
      <style>{ghostStyles}</style>
      <span className="ghost-icon" style={{ width: size, height: size }}>
        <span className="ghost-inner" style={{ transform: `translate(-50%, -50%) scale(${scale})` }}>
        <span className="ghost-body">
          <span className="ghost-pupil ghost-pupil-left" />
          <span className="ghost-pupil ghost-pupil-right" />
          <span className="ghost-eye ghost-eye-left" />
          <span className="ghost-eye ghost-eye-right" />
          <span data-g="top0" />
          <span data-g="top1" />
          <span data-g="top2" />
          <span data-g="top3" />
          <span data-g="top4" />
          <span data-g="st0" />
          <span data-g="st1" />
          <span data-g="st2" />
          <span data-g="st3" />
          <span data-g="st4" />
          <span data-g="st5" />
          <span data-g="an1" />
          <span data-g="an2" />
          <span data-g="an3" />
          <span data-g="an4" />
          <span data-g="an5" />
          <span data-g="an6" />
          <span data-g="an7" />
          <span data-g="an8" />
          <span data-g="an9" />
          <span data-g="an10x" />
          <span data-g="an11" />
          <span data-g="an12" />
          <span data-g="an13" />
          <span data-g="an14" />
          <span data-g="an15" />
          <span data-g="an16" />
          <span data-g="an17" />
          <span data-g="an18" />
        </span>
      </span>
    </span>
  </>
  );
};
