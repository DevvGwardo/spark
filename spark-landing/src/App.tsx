import { useState, useMemo } from "react";
import { CategoryRail } from "./components/CategoryRail";
import { Hero } from "./components/Hero";
import { FeatureCard } from "./components/FeatureCard";
import { GetSpark } from "./components/GetSpark";
import { Icon } from "./components/Icon";
import { features } from "./data/features";

const REPO = "https://github.com/DevvGwardo/spark";

function App() {
  const [filter, setFilter] = useState("all");

  const visible = useMemo(
    () => (filter === "all" ? features : features.filter((f) => f.category === filter)),
    [filter]
  );

  return (
    <div className="site">
      <div className="hero-wrap">
        <nav className="nav">
          {/* Lenis handles smooth anchor scrolling (anchors: true) */}
          <a className="nav-logo" href="#top">
            <img src="/spark-app-icon.png" alt="" width={30} height={30} />
            <span>Spark</span>
          </a>
          <div className="nav-links">
            <a className="nav-link" href="#features">Features</a>
            <a className="nav-link" href="#get">Download</a>
          </div>
          <div className="nav-actions">
            <a className="btn btn-frost btn-sm" href={REPO} target="_blank" rel="noopener">GitHub</a>
            <button className="btn btn-pill btn-sm" onClick={() => window.open(`${REPO}/releases`, "_blank")}>
              Get started <Icon name="arrowUpRight" />
            </button>
          </div>
        </nav>

        <Hero />
      </div>

      <div className="content">
        <section className="section" id="features">
          <div className="section-head">
            <p className="eyebrow">Features</p>
            <h2>Everything the agent needs, in one desktop.</h2>
            <p className="section-sub">
              Autonomous coding, parallel sessions, live preview, and 15+ providers —
              all wrapped in a fast native app.
            </p>
          </div>

          <CategoryRail currentFilter={filter} onFilterChange={setFilter} />

          <div className="grid">
            {visible.map((feature) => (
              <FeatureCard key={feature.id} feature={feature} />
            ))}
          </div>
        </section>

        <GetSpark />

        <footer className="footer">
          <span>Spark · desktop GUI for the Hermes agent</span>
          <span>
            Free · open source ·{" "}
            <a href={REPO} target="_blank" rel="noopener">GitHub</a>
          </span>
        </footer>
      </div>
    </div>
  );
}

export default App;
