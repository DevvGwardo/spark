import { categories } from "../data/features";

interface Props {
  currentFilter: string;
  onFilterChange: (filter: string) => void;
}

export function CategoryRail({ currentFilter, onFilterChange }: Props) {
  return (
    <aside className="rail">
      <div className="rail-logo" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>
        <img className="rail-mark" src="/spark-mark.svg" alt="" width={24} height={24} />
        <span>Spark</span>
      </div>
      <p className="rail-label">Features</p>
      {categories.map((cat) => (
        <button
          key={cat.id}
          className={`rail-btn ${currentFilter === cat.id ? "active" : ""}`}
          onClick={() => onFilterChange(cat.id)}
        >
          {cat.label}
        </button>
      ))}
    </aside>
  );
}
