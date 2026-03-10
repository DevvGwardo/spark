// Type declarations for Shoelace web components used in JSX
import type { SlDetails, SlCopyButton, SlTooltip } from '@shoelace-style/shoelace';

declare global {
  namespace JSX {
    interface IntrinsicElements {
      'sl-details': React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          open?: boolean;
          summary?: string;
          disabled?: boolean;
          onSlAfterShow?: () => void;
          onSlAfterHide?: () => void;
        },
        HTMLElement
      >;
      'sl-copy-button': React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          value?: string;
          from?: string;
          disabled?: boolean;
          'copy-label'?: string;
          'success-label'?: string;
          'error-label'?: string;
        },
        HTMLElement
      >;
      'sl-tooltip': React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          content?: string;
          placement?: string;
          disabled?: boolean;
        },
        HTMLElement
      >;
    }
  }
}

export {};
