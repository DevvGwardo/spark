import { Icon } from "./Icon";

const RELEASES = "https://github.com/DevvGwardo/spark/releases";
const REPO = "https://github.com/DevvGwardo/spark";

export function GetSpark() {
  return (
    <aside className="aside">
      <div className="aside-head">
        <span className="live" />
        <h2>Get Spark</h2>
      </div>
      <p className="lede">
        Free and open source. Install the desktop app, connect the Hermes bridge, and
        start handing off real work.
      </p>

      <div className="dl-group">
        <button className="dl-btn primary" onClick={() => window.open(RELEASES, "_blank")}>
          <span className="os"><Icon name="download" /> Download for desktop</span>
        </button>
        <button className="dl-btn" onClick={() => window.open(RELEASES, "_blank")}>
          <span className="os"><Icon name="desktop" /> macOS · Windows · Linux</span>
        </button>
      </div>

      <div className="stats">
        <div className="stat"><span>Providers</span><strong>15+</strong></div>
        <div className="stat"><span>Agent toolsets</span><strong>7</strong></div>
        <div className="stat"><span>Runtime</span><strong>Hermes bridge</strong></div>
        <div className="stat"><span>Price</span><strong>Free · OSS</strong></div>
      </div>

      <p className="aside-foot">
        Powered by <b>Hermes</b> — Nous Research's autonomous agent.{" "}
        <a href={REPO} target="_blank" rel="noopener" style={{ color: "var(--accent)" }}>
          Source on GitHub →
        </a>
      </p>
    </aside>
  );
}
