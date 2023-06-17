import { Channel } from '@johnlindquist/kit/cjs/enum';
import { useAtom } from 'jotai';
import { useEffect, useRef } from 'react';

import { useHotkeys } from 'react-hotkeys-hook';
import {
  channelAtom,
  indexAtom,
  mouseEnabledAtom,
  inputFocusAtom,
  shortcutsAtom,
  listAtom,
  directionAtom,
} from '../jotai';

import { hotkeysOptions } from './shared';

export default () => {
  const [index, setIndex] = useAtom(indexAtom);
  const [, setMouseEnabled] = useAtom(mouseEnabledAtom);
  const [channel] = useAtom(channelAtom);
  const [inputFocus] = useAtom(inputFocusAtom);
  const [shortcuts] = useAtom(shortcutsAtom);
  const [, setDirection] = useAtom(directionAtom);

  // useEffect(() => {
  //   const list = document.getElementById('list');
  //   if (!list) return;

  //   listRef.current = list;
  // }, []);

  useHotkeys(
    'up',
    (event) => {
      if (!inputFocus) return;
      event.preventDefault();
      setMouseEnabled(0);
      setDirection(-1);
      setIndex(index - 1);
      channel(Channel.UP);
    },
    hotkeysOptions,
    [index, channel, inputFocus, shortcuts]
  );

  useHotkeys(
    'down',
    (event) => {
      if (!inputFocus) return;
      event.preventDefault();
      setMouseEnabled(0);
      setDirection(1);
      setIndex(index + 1);
      channel(Channel.DOWN);
    },
    hotkeysOptions,
    [index, channel, inputFocus, shortcuts]
  );

  useHotkeys(
    'left',
    (event) => {
      if (!inputFocus) return;
      // event.preventDefault();
      channel(Channel.LEFT);
    },
    hotkeysOptions,
    [channel, inputFocus, shortcuts]
  );

  useHotkeys(
    'right',
    (event) => {
      if (!inputFocus) return;
      // event.preventDefault();
      channel(Channel.RIGHT);
    },
    hotkeysOptions,
    [channel, inputFocus, shortcuts]
  );
};
