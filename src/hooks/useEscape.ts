import { UI } from '@johnlindquist/kit/cjs/enum';
import { useAtom } from 'jotai';

import { useHotkeys } from 'react-hotkeys-hook';
import {
  flagValueAtom,
  _index,
  openAtom,
  prevIndexAtom,
  prevInputAtom,
  _input,
  isReadyAtom,
  escapeAtom,
  uiAtom,
  runMainScriptAtom,
} from '../jotai';
import { hotkeysOptions } from './shared';

export default () => {
  const [open] = useAtom(openAtom);
  const [sendEscape] = useAtom(escapeAtom);
  const [isReady] = useAtom(isReadyAtom);
  const [flagValue, setFlagValue] = useAtom(flagValueAtom);
  const [input] = useAtom(_input);
  const [prevInput] = useAtom(prevInputAtom);

  const [index] = useAtom(_index);
  const [prevIndex] = useAtom(prevIndexAtom);
  const [ui] = useAtom(uiAtom);
  const [runMainScript] = useAtom(runMainScriptAtom);

  useHotkeys(
    'escape',
    (event) => {
      console.log(`useEscape`, { flagValue, isReady, ui: ui === UI.splash });
      event.preventDefault();
      if (flagValue) {
        setFlagValue('');
      } else if (isReady && ui === UI.splash) {
        runMainScript();
      } else if (isReady) {
        sendEscape();
      }
    },
    hotkeysOptions,
    [
      open,
      flagValue,
      prevInput,
      prevIndex,
      index,
      input,
      isReady,
      ui,
      runMainScript,
    ]
  );
};
