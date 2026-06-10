import type { CSSProperties } from "react";
import type { Feature } from "../data/features";
import { Icon } from "./Icon";

export function FeatureCard({ feature, index = 0 }: { feature: Feature; index?: number }) {
  return (
    <article className="feature-card" style={{ "--i": index } as CSSProperties}>
      <div className="feature-icon">
        <Icon name={feature.icon} />
      </div>
      <span className="feature-tag">{feature.tag}</span>
      <h3>{feature.name}</h3>
      <p>{feature.note}</p>
    </article>
  );
}
