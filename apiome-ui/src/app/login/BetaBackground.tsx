import React from 'react';

/**
 * The tiled "BETA" watermark behind an auth card.
 *
 * Only `/login/2fa` still draws it. HIVE-4.1 (#5295) replaced it on `/login` with
 * `components/auth/BetaBadge` — a honey chip beside the mark, behind the same
 * `NEXT_PUBLIC_BETA_MODE` flag — because a full-screen rotated watermark competed with the
 * one decision on the page, named a grey no theme could move, and had to be switched off by
 * hand before a visual snapshot could be taken. HIVE-4.2 (#5296) re-skins the two-factor
 * screen and retires this file with it.
 */
const BetaBackground: React.FC = () => {
  return (
    <div className="fixed inset-0 overflow-hidden pointer-events-none z-0">
      <div
        className="absolute inset-0"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%) rotate(-45deg)',
            /* The rotated watermark behind the sign-in card. `rem`, like the rest of the
               interface (HIVE-1.6): the ornament is proportioned against the card in
               front of it, so it has to travel with the font-size preference too. */
            fontSize: '7.5rem',
            lineHeight: '11.25rem',
            fontWeight: 'bold',
            color: '#D1D5DB',
            opacity: 0.25,
            whiteSpace: 'nowrap',
            userSelect: 'none',
            width: '300%',
            height: '300%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '40px',
          }}
        >
          {/* Create multiple rows of BETA text */}
          {Array.from({ length: 20 }).map((_, rowIndex) => (
            <div
              key={rowIndex}
              style={{
                display: 'flex',
                gap: '150px',
                width: '100%',
                justifyContent: 'center',
              }}
            >
              {Array.from({ length: 10 }).map((_, colIndex) => (
                <span key={colIndex}>
                  BETA
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default BetaBackground;

