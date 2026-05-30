import { useNavigate } from "react-router-dom";
import StatusCard from "./StatusCard";
import RevivalPanel from "./RevivalPanel";

const MobileShell = () => {
  const navigate = useNavigate();

  return (
    <div className="mx-auto flex min-h-screen max-w-[390px] flex-col overflow-x-hidden bg-background px-4 py-5">
      {/* Top bar */}
      <div className="mb-5 flex items-center justify-between">
        <h1 className="font-sans text-sm font-medium text-foreground">
          Spark
        </h1>
        <span className="inline-flex items-center rounded-full border border-border px-2.5 py-0.5 font-sans text-[11px] font-medium text-muted-foreground">
          Hermes Host
        </span>
      </div>

      {/* StatusCard slot */}
      <div className="mb-5">
        {/* StatusCard owned by another agent */}
        <StatusCard />
      </div>

      {/* Primary CTA */}
      <button
        type="button"
        onClick={() => navigate("/m/chat")}
        className="mb-5 inline-flex w-full items-center justify-center rounded-md bg-primary px-4 py-3 font-sans text-sm font-medium text-primary-foreground transition-theme hover:opacity-90"
        style={{ minHeight: 44 }}
      >
        Chat
      </button>

      {/* RevivalPanel slot */}
      <div>
        {/* RevivalPanel owned by another agent */}
        <RevivalPanel />
      </div>
    </div>
  );
};

export default MobileShell;
