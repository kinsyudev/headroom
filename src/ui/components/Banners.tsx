import type { Banner } from '../../shared/view';
import type { Connection } from '../api';
import { Age, Clock } from './Countdown';

export function Banners(props: { readonly banners: readonly Banner[]; readonly connection: Connection }) {
  if (props.banners.length === 0 && props.connection !== 'lost') return null;
  return (
    <div className="banners" role="alert">
      {props.connection === 'lost' && <p className="banner critical">Lost contact with the deck server. Retrying every 2 s; ages keep counting.</p>}
      {props.banners.map((b, i) => (
        <p key={i} className={`banner ${b.kind === 'claim_unknown' || b.kind === 'keeper_unavailable' ? 'warning' : 'critical'}`}>
          <BannerText banner={b} />
        </p>
      ))}
    </div>
  );
}

function BannerText(props: { readonly banner: Banner }) {
  const b = props.banner;
  switch (b.kind) {
    case 'link':
      return b.link.kind === 'missing_key' ? (
        <>No CPA_MANAGEMENT_KEY in {b.link.envPath}. Nothing is sent to CPA until it is set; the deck re-reads the file on its own.</>
      ) : (
        <>
          CPA rejected the management key, so the deck stopped every management call to avoid CPA's IP ban. Fix CPA_MANAGEMENT_KEY in {b.link.envPath}. A changed key is tried at once; the same key is tried again at{' '}
          {b.retryAt !== null && <Clock at={b.retryAt} />}.
        </>
      );
    case 'cpa_unreachable':
      return (
        <>
          CPA is not answering. The cards show its last answer{b.lastAt !== null && <>, from <Age at={b.lastAt} /> ago</>}.
        </>
      );
    case 'claim_unknown':
      return (
        <>
          A {b.program} claim on {b.email} may have reached Anthropic. The next reset read decides; it will not be resent.
        </>
      );
    case 'keeper_unavailable':
      return <>keeper's database is unreadable ({b.message}). Serving evidence falls back to CPA headers; history is unavailable.</>;
  }
}
