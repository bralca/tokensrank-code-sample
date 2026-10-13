type LoadingSkeletonProps = {
  className?: string;
  rounded?: 'sm' | 'md' | 'lg' | 'full';
};

const roundedClassName = {
  sm: 'rounded-sm',
  md: 'rounded-md',
  lg: 'rounded-lg',
  full: 'rounded-full',
} as const;

export function LoadingSkeleton({ className = '', rounded = 'md' }: LoadingSkeletonProps) {
  return (
    <span
      aria-hidden="true"
      className={`tr-skeleton-shimmer block bg-tr-bg-row ${roundedClassName[rounded]} ${className}`}
    />
  );
}
