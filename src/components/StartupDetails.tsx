import type { Startup } from "@/lib/flag/startup";
import Icon from "./Icon";

/** Short editorial block under the two flags: who the startup is and where to go next. */
export default function StartupDetails({ startup }: { startup: Startup }) {
  const meta = [startup.category, startup.location].filter(Boolean).join(" · ");
  return (
    // key restarts the entrance animation when the startup changes.
    <section key={startup.id} className="startup" aria-labelledby="startup-name" aria-live="polite">
      <p className="startup-trail">
        <span>Argentina</span>
        <Icon name="arrow" size={13} />
        <span>{startup.name}</span>
      </p>
      <h2 id="startup-name" className="startup-name">{startup.name}</h2>
      {meta && <p className="startup-meta">{meta}</p>}
      {startup.description && <p className="startup-desc">{startup.description}</p>}
      <div className="startup-links">
        <a className="startup-cta" href={startup.website} target="_blank" rel="noopener noreferrer nofollow">
          Visit website <Icon name="arrow" size={15} />
        </a>
        <span className="startup-domain">{startup.domain}</span>
        {startup.socialLinks.map((s) => (
          <a key={s.url} className="startup-social" href={s.url} target="_blank" rel="noopener noreferrer nofollow">
            {s.label}
          </a>
        ))}
      </div>
    </section>
  );
}
