import { Icon } from "./Icon";

const RELEASES = "https://github.com/DevvGwardo/spark/releases";
const REPO = "https://github.com/DevvGwardo/spark";

export function GetSpark() {
  return (
    <section className="cta" id="get">
      <div className="cta-card">
        <div className="cta-head">
          <span className="live" />
          <h2>Get Spark</h2>
        </div>
        <p className="cta-lede">
          Free and open source. Install the desktop app, connect the Hermes bridge, and
          start handing off real work.
        </p>

        <div className="dl-group">
          <button className="btn btn-pill" onClick={() => window.open(RELEASES, "_blank")}>
            <Icon name="download" /> Download for desktop
          </button>
          <a className="btn btn-ghost" href={RELEASES} target="_blank" rel="noopener">
            <Icon name="desktop" /> macOS · Windows · Linux
          </a>
        </div>

        <div className="stats">
          <div className="stat"><span>Providers</span><strong>15+</strong></div>
          <div className="stat"><span>Agent toolsets</span><strong>7</strong></div>
          <div className="stat"><span>Runtime</span><strong>Hermes bridge</strong></div>
          <div className="stat"><span>Price</span><strong>Free · OSS</strong></div>
        </div>

        <p className="cta-foot">
          Powered by <b>Hermes</b> — Nous Research's autonomous agent.{" "}
          <a href={REPO} target="_blank" rel="noopener">Source on GitHub →</a>
        </p>
      </div>
    </section>
  );
}
