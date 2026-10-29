import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, Network } from 'lucide-react';
import type { VpnProfile } from '../types';

type Props = {
  profiles: VpnProfile[];
  selectedId: string | null;
  disabled: boolean;
  locale: 'zh' | 'en';
  onSelect: (id: string) => void;
};

export function ProfileSelect({ profiles, selectedId, disabled, locale, onSelect }: Props) {
  const cn = locale === 'zh';
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(selectedId);
  const selected = profiles.find((profile) => profile.id === selectedId);
  const enabled = profiles.filter((profile) => !profile.error);
  const expanded = open && !disabled;
  const optionId = (value: string) => `${id}-option-${value}`;

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!expanded) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [expanded]);

  useEffect(() => {
    if (expanded && activeId)
      document.getElementById(optionId(activeId))?.scrollIntoView({ block: 'nearest' });
  }, [expanded, activeId]);

  const show = () => {
    setActiveId(
      enabled.some((profile) => profile.id === selectedId) ? selectedId : enabled[0]?.id || null,
    );
    setOpen(true);
  };
  const choose = (value: string) => {
    setOpen(false);
    button.current?.focus();
    if (value !== selectedId) onSelect(value);
  };

  return (
    <div className="profile-select" ref={root}>
      <button
        ref={button}
        type="button"
        className="profile-select-trigger"
        role="combobox"
        aria-label={cn ? '连接配置' : 'Connection profile'}
        aria-haspopup="listbox"
        aria-expanded={expanded}
        aria-controls={expanded ? `${id}-list` : undefined}
        aria-activedescendant={expanded && activeId ? optionId(activeId) : undefined}
        disabled={disabled || !profiles.length}
        onClick={() => (expanded ? setOpen(false) : show())}
        onBlur={(event) => {
          if (!root.current?.contains(event.relatedTarget)) setOpen(false);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' || event.key === 'Tab') {
            setOpen(false);
            if (event.key === 'Escape') event.preventDefault();
          } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            if (!expanded) {
              show();
              return;
            }
            const index = enabled.findIndex((profile) => profile.id === activeId);
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? enabled.length - 1
                  : (index + (event.key === 'ArrowUp' ? -1 : 1) + enabled.length) % enabled.length;
            setActiveId(enabled[next]?.id || null);
          } else if ((event.key === 'Enter' || event.key === ' ') && expanded) {
            event.preventDefault();
            if (activeId && enabled.some((profile) => profile.id === activeId)) choose(activeId);
          }
        }}
      >
        <span className="profile-select-icon">
          <Network size={17} strokeWidth={1.8} />
        </span>
        <span className="profile-select-value">
          {selected?.displayName || (cn ? '请选择或导入配置' : 'Select or import a profile')}
        </span>
        <ChevronDown className="profile-select-chevron" size={16} />
      </button>
      {expanded && (
        <ul
          id={`${id}-list`}
          className="profile-select-menu"
          role="listbox"
          aria-label={cn ? '可用配置' : 'Available profiles'}
        >
          {profiles.map((profile) => (
            <li
              id={optionId(profile.id)}
              key={profile.id}
              role="option"
              aria-selected={profile.id === selectedId}
              aria-disabled={Boolean(profile.error)}
              className={`profile-select-option ${activeId === profile.id ? 'is-active' : ''}`}
              onPointerDown={(event) => event.preventDefault()}
              onPointerMove={() => {
                if (!profile.error) setActiveId(profile.id);
              }}
              onClick={() => {
                if (!profile.error) choose(profile.id);
              }}
            >
              <span className="profile-option-copy">
                <span className="profile-option-name">{profile.displayName}</span>
                <span className="profile-option-meta">
                  {profile.error
                    ? cn
                      ? '配置不可用，请检查或重新导入'
                      : 'Unavailable — check or reimport'
                    : [
                        profile.source === 'builtin'
                          ? cn
                            ? '内置'
                            : 'Built-in'
                          : cn
                            ? '导入'
                            : 'Imported',
                        profile.endpoints[0]?.host,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                </span>
              </span>
              {profile.id === selectedId && <Check size={16} strokeWidth={2} aria-hidden="true" />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
