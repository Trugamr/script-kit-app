import React, { useEffect } from 'react';
import { motion, useAnimation } from 'framer-motion';

export default function TopBar() {
  const controls = useAnimation();

  useEffect(() => {
    controls.start({
      left: ['-25%', '100%'],
      opacity: [0, 1, 0],
    });

    return () => {
      controls.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div
      className={`
      pointer-events-none absolute left-0 top-0 -mt-px h-0.75 w-full
      overflow-hidden
      `}
    >
      <motion.div
        animate={controls}
        transition={{
          ease: 'easeInOut',
          repeat: Infinity,
          repeatType: 'reverse',

          duration: window.innerWidth < 400 ? 1.5 : 2.5,
        }}
        className="absolute left-0 top-0 h-full w-1/4
        bg-gradient-to-r
        from-transparent via-primary to-transparent
        "
      />
    </div>
  );
}
