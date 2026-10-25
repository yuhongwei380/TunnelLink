import { Check, Laptop, LockKeyhole, Server, ShieldCheck } from 'lucide-react';
import type { VpnState } from '../types';

type Props = {
  state: VpnState;
  deviceLabel: string;
  networkLabel: string;
  tunnelLabel: string;
};

/** A schematic, not a live topology or an assertion about the user's public IP. */
export function ConnectionVisual({ state, deviceLabel, networkLabel, tunnelLabel }: Props) {
  return (
    <div className={`connection-visual visual-${state.toLowerCase()}`} aria-hidden="true">
      <div className="orbit-scene">
        <div className="orbit orbit-outer" />
        <div className="orbit orbit-inner" />
        <span className="orbit-dot dot-one" />
        <span className="orbit-dot dot-two" />
        <svg className="tunnel-path" viewBox="0 0 300 230" fill="none">
          <path className="tunnel-track" d="M42 160 L150 98 L258 160" />
          <path className="tunnel-flow" d="M42 160 L150 98 L258 160" />
        </svg>
        <div className="shield-platform">
          <ShieldCheck size={53} strokeWidth={1.3} />
          <span className="shield-status">
            {state === 'CONNECTED' ? <Check size={13} /> : <LockKeyhole size={12} />}
          </span>
        </div>
        <div className="network-endpoint endpoint-device">
          <span>
            <Laptop size={23} strokeWidth={1.6} />
          </span>
          <small>{deviceLabel}</small>
        </div>
        <div className="network-endpoint endpoint-gateway">
          <span>
            <Server size={22} strokeWidth={1.6} />
          </span>
          <small>{networkLabel}</small>
        </div>
      </div>
      <div className="tunnel-caption">
        <span />
        {tunnelLabel}
      </div>
    </div>
  );
}
