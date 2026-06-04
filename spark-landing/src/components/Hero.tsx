import { Icon } from "./Icon";

const REPO = "https://github.com/DevvGwardo/spark";

export function Hero() {
  return (
    <header className="hero">
      <img className="hero-mark" src="/spark-mark.svg" alt="Spark logo" width={58} height={58} />
      <p className="eyebrow">
        <span className="spark">Spark</span> · desktop GUI for the Hermes agent
      </p>
      <h1>The AI desktop with an autonomous agent brain.</h1>
      <p className="subtitle">
        Spark is a native desktop app built around Hermes — Nous Research's autonomous
        agent that reads your code, runs terminals, browses the web, and ships pull
        requests. Point it at any of 15+ providers and let it work.
      </p>
      <div className="hero-actions">
        <button className="btn btn-primary" onClick={() => window.open(`${REPO}/releases`, "_blank")}>
          <Icon name="download" /> Download
        </button>
        <a className="btn" href={REPO} target="_blank" rel="noopener">
          <Icon name="github" /> View on GitHub
        </a>
      </div>
    </header>
  );
}
