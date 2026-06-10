import { Icon } from "./Icon";

const REPO = "https://github.com/DevvGwardo/spark";
const RELEASES = `${REPO}/releases`;

export function Hero() {
  return (
    <header className="hero" id="top">
      <div className="app-icon" aria-hidden="true">
        <Icon name="terminal" />
      </div>
      <h1 className="wordmark">Spark</h1>
      <p className="subtitle">
        A desktop coding agent that reads your code, runs terminals, and ships
        PRs — powered by Hermes.
      </p>
      <div className="hero-actions">
        <button
          className="btn btn-pill btn-glimmer"
          onClick={() => window.open(RELEASES, "_blank")}
        >
          Download for desktop
        </button>
        <a className="btn btn-frost" href={REPO} target="_blank" rel="noopener">
          Explore on GitHub
        </a>
      </div>
      <p className="available">
        Available on{" "}
        <a href={RELEASES} target="_blank" rel="noopener">macOS</a>,{" "}
        <a href={RELEASES} target="_blank" rel="noopener">Windows</a> and{" "}
        <a href={RELEASES} target="_blank" rel="noopener">Linux</a>
      </p>
    </header>
  );
}
