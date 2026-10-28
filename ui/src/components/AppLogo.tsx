import appIcon from '../../../resources/brand/app-icon.svg';

export function AppLogo() {
  return (
    <img
      className="brand-icon"
      src={appIcon}
      alt=""
      aria-hidden="true"
      width={42}
      height={42}
      draggable={false}
    />
  );
}
