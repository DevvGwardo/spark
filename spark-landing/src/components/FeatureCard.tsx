import type { Feature } from "../data/features";
import { Icon } from "./Icon";

export function FeatureCard({ feature }: { feature: Feature }) {
  return (
    <article className="feature-card">
      <div className="feature-icon">
        <Icon name={feature.icon} />
      </div>
      <span className="feature-tag">{feature.tag}</span>
      <h3>{feature.name}</h3>
      <p>{feature.note}</p>
    </article>
  );
}
