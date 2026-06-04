import { useState, useMemo } from "react";
import { CategoryRail } from "./components/CategoryRail";
import { Hero } from "./components/Hero";
import { FeatureCard } from "./components/FeatureCard";
import { GetSpark } from "./components/GetSpark";
import { features } from "./data/features";

function App() {
  const [filter, setFilter] = useState("all");

  const visible = useMemo(
    () => (filter === "all" ? features : features.filter((f) => f.category === filter)),
    [filter]
  );

  return (
    <div className="app-shell">
      <CategoryRail currentFilter={filter} onFilterChange={setFilter} />

      <main className="main">
        <Hero />
        <section className="grid">
          {visible.map((feature) => (
            <FeatureCard key={feature.id} feature={feature} />
          ))}
        </section>
      </main>

      <GetSpark />
    </div>
  );
}

export default App;
