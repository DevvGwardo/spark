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
      <div className="nav-wrap">
        <nav className="nav">
          <a className="nav-logo" href="#top" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>
            <img src="/spark-mark.svg" alt="Spark" width={26} height={26} />
            <span>Spark</span>
          </a>
          <div className="nav-actions">
            <a className="nav-link" href="#features">Features</a>
            <a className="nav-link" href={REPO} target="_blank" rel="noopener">GitHub</a>
            <button className="btn btn-pill btn-sm" onClick={() => window.open(`${REPO}/releases`, "_blank")}>
              Get started <Icon name="arrowRight" />
            </button>
          </div>
        </nav>
      </div>

      <main>
        <Hero />

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
      </main>

      <footer className="footer">
        <span>Spark · desktop GUI for the Hermes agent</span>
        <span>
          Free · open source ·{" "}
          <a href={REPO} target="_blank" rel="noopener">GitHub</a>
        </span>
      </footer>
    </div>
  );
}

export default App;
