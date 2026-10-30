import { useState } from 'react';
import { Plus, Settings2, X } from 'lucide-react';
import { useDialog } from '../hooks/useDialog';
import type { ProfileList } from '../types';
import { ProfileSelect } from './ProfileSelect';

type Props = {
  data: ProfileList | null;
  locale: 'zh' | 'en';
  locked: boolean;
  pending: boolean;
  onAction: (
    action: 'import' | 'select' | 'rename' | 'delete',
    id?: string,
    name?: string,
  ) => Promise<void>;
};

export function ProfileManager({ data, locale, locked, pending, onAction }: Props) {
  const cn = locale === 'zh';
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState('');
  const [name, setName] = useState('');
  const [deleting, setDeleting] = useState('');
  const dialog = useDialog(open);
  const selected = data?.profiles.find((p) => p.id === data.selectedProfileId);
  return (
    <section className="profile-panel" aria-label={cn ? '连接配置' : 'Connection profiles'}>
      <div className="profile-picker-row">
        <span className="profile-picker-label">{cn ? '连接配置' : 'Connection profile'}</span>
        <ProfileSelect
          profiles={data?.profiles || []}
          selectedId={data?.selectedProfileId || null}
          locale={locale}
          disabled={locked || pending || !data}
          onSelect={(id) => void onAction('select', id)}
        />
        {data?.capabilities.profileImport.enabled && (
          <button
            className="profile-toolbar-button"
            disabled={pending}
            onClick={() => void onAction('import')}
          >
            <Plus size={16} />
            {cn ? '导入' : 'Import'}
          </button>
        )}
        <button
          className="profile-toolbar-button"
          disabled={!data || pending}
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
        >
          <Settings2 size={16} />
          {cn ? '管理' : 'Manage'}
        </button>
      </div>
      {selected && (
        <div className="profile-description">
          <span>
            {selected.source === 'builtin'
              ? cn
                ? '内置配置'
                : 'Built-in profile'
              : cn
                ? '导入配置'
                : 'Imported profile'}
          </span>
          {selected.description && <p>{selected.description}</p>}
          {selected.error && <p role="alert">{selected.error}</p>}
        </div>
      )}
      {data && !data.profiles.length && (
        <p className="profile-description">
          {cn
            ? '导入 .ovpn 配置文件开始连接。外部证书可在导入时选择。'
            : 'Import an .ovpn file to connect. External certificates can be selected during import.'}
        </p>
      )}
      <dialog
        ref={dialog}
        className="profile-dialog"
        onCancel={() => {
          if (!pending) setOpen(false);
        }}
        aria-labelledby="profiles-title"
      >
        <div className="profile-picker-row">
          <h2 id="profiles-title">{cn ? '管理连接配置' : 'Manage profiles'}</h2>
          <button
            className="switch-user-button"
            disabled={pending}
            aria-label={cn ? '关闭' : 'Close'}
            onClick={() => setOpen(false)}
          >
            <X size={18} />
          </button>
        </div>
        {data?.profiles.map((profile) => (
          <div className="profile-item" key={profile.id}>
            <strong>{profile.displayName}</strong>
            <span className="profile-description">
              {profile.source === 'builtin'
                ? cn
                  ? '内置，只读'
                  : 'Built-in, read-only'
                : cn
                  ? '导入配置'
                  : 'Imported profile'}
            </span>
            {profile.error && <p role="alert">{profile.error}</p>}
            {profile.source === 'imported' && (
              <>
                {editing === profile.id ? (
                  <div className="profile-picker-row">
                    <input
                      aria-label={cn ? '配置名称' : 'Profile name'}
                      value={name}
                      maxLength={100}
                      onChange={(e) => setName(e.target.value)}
                    />
                    <button
                      disabled={pending || locked || !name.trim()}
                      onClick={() =>
                        void onAction('rename', profile.id, name).then(() => setEditing(''))
                      }
                    >
                      {cn ? '保存' : 'Save'}
                    </button>
                    <button onClick={() => setEditing('')}>{cn ? '取消' : 'Cancel'}</button>
                  </div>
                ) : (
                  <button
                    disabled={pending || locked}
                    onClick={() => {
                      setEditing(profile.id);
                      setName(profile.displayName);
                    }}
                  >
                    {cn ? '重命名' : 'Rename'}
                  </button>
                )}
                {deleting === profile.id ? (
                  <div>
                    <p>
                      {cn
                        ? '删除此配置及保存的凭据？'
                        : 'Delete this profile and its saved credentials?'}
                    </p>
                    <button
                      disabled={pending || locked}
                      onClick={() =>
                        void onAction('delete', profile.id).then(() => setDeleting(''))
                      }
                    >
                      {cn ? '确认删除' : 'Delete'}
                    </button>
                    <button onClick={() => setDeleting('')}>{cn ? '取消' : 'Cancel'}</button>
                  </div>
                ) : (
                  <button disabled={pending || locked} onClick={() => setDeleting(profile.id)}>
                    {cn ? '删除' : 'Delete'}
                  </button>
                )}
              </>
            )}
          </div>
        ))}
        {locked && (
          <p>
            {cn
              ? '断开连接后可以切换或修改配置。'
              : 'Disconnect before switching or editing profiles.'}
          </p>
        )}
      </dialog>
    </section>
  );
}
