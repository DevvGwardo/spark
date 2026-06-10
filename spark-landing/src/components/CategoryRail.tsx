import { categories } from "../data/features";

interface Props {
  currentFilter: string;
  onFilterChange: (filter: string) => void;
}

export function CategoryRail({ currentFilter, onFilterChange }: Props) {
  return (
    <div className="filters" role="tablist" aria-label="Filter features">
      {categories.map((cat) => (
        <button
          key={cat.id}
          role="tab"
          aria-selected={currentFilter === cat.id}
          className={`chip ${currentFilter === cat.id ? "active" : ""}`}
          onClick={() => onFilterChange(cat.id)}
        >
          {cat.label}
        </button>
      ))}
    </div>
  );
}
