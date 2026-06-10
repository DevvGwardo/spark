import { Icon } from "./Icon";

const REPO = "https://github.com/DevvGwardo/spark";

export function Hero() {
  return (
    <header className="hero" id="top">
      <span className="badge">
        <span className="dot" /> Desktop GUI for the Hermes agent
      </span>
      <h1>The AI desktop with an autonomous agent brain.</h1>
      <p className="subtitle">
        Spark is a native desktop app built around Hermes — Nous Research's autonomous
        agent that reads your code, runs terminals, browses the web, and ships pull
        requests. Point it at any of 15+ providers and let it work.
      </p>
      <div className="hero-actions">
        <button className="btn btn-pill" onClick={() => window.open(`${REPO}/releases`, "_blank")}>
          Get started <Icon name="arrowRight" />
        </button>
        <a className="btn btn-ghost" href={REPO} target="_blank" rel="noopener">
          <Icon name="github" /> View on GitHub
        </a>
      </div>
      <p className="hero-foot">Free &amp; open source · macOS · Windows · Linux</p>
    </header>
  );
}
