import { useAtom, useSetAtom } from 'jotai';
import React, {
  useEffect,
  FC,
  Key,
  useRef,
  useState,
  useCallback,
} from 'react';

import { Channel, Mode, UI } from '@johnlindquist/kit/cjs/enum';

import classNames from 'classnames';
import { FaChevronDown } from 'react-icons/fa';
import {
  Input,
  Button,
  MessageType,
  MessageBox,
  IMessageListProps,
  MessageListEvent,
} from 'react-chat-elements';

import {
  chatMessagesAtom,
  chatMessageSubmitAtom,
  placeholderAtom,
  inputAtom,
  channelAtom,
  _index,
} from '../jotai';

const ChatList: FC<IMessageListProps> = ({
  referance = null,
  lockable = false,
  toBottomHeight = 300,
  downButton,
  ...props
}) => {
  const [scrollBottom, setScrollBottom] = useState(0);
  const [_downButton, setDownButton] = useState(false);
  const prevProps = useRef(props);

  const checkScroll = () => {
    const e = referance;
    if (!e || !e.current) return;

    if (
      toBottomHeight === '100%' ||
      (toBottomHeight && scrollBottom < toBottomHeight)
    ) {
      e.current.scrollTop = e.current.scrollHeight; // scroll to bottom
    } else if (lockable === true) {
      e.current.scrollTop =
        e.current.scrollHeight - e.current.offsetHeight - scrollBottom;
    }
  };

  useEffect(() => {
    if (!referance) return;

    if (prevProps.current.dataSource.length !== props.dataSource.length) {
      setScrollBottom(getBottom(referance));
      checkScroll();
    }

    prevProps.current = props;
  }, [prevProps, props]);

  const getBottom = (e: any) => {
    if (e.current)
      return (
        e.current.scrollHeight - e.current.scrollTop - e.current.offsetHeight
      );
    return e.scrollHeight - e.scrollTop - e.offsetHeight;
  };

  const onOpen: MessageListEvent = (item, index, event) => {
    if (props.onOpen instanceof Function) props.onOpen(item, index, event);
  };

  const onDownload: MessageListEvent = (item, index, event) => {
    if (props.onDownload instanceof Function)
      props.onDownload(item, index, event);
  };

  const onPhotoError: MessageListEvent = (item, index, event) => {
    if (props.onPhotoError instanceof Function)
      props.onPhotoError(item, index, event);
  };

  const onClick: MessageListEvent = (item, index, event) => {
    if (props.onClick instanceof Function) props.onClick(item, index, event);
  };

  const onTitleClick: MessageListEvent = (item, index, event) => {
    if (props.onTitleClick instanceof Function)
      props.onTitleClick(item, index, event);
  };

  const onForwardClick: MessageListEvent = (item, index, event) => {
    if (props.onForwardClick instanceof Function)
      props.onForwardClick(item, index, event);
  };

  const onReplyClick: MessageListEvent = (item, index, event) => {
    if (props.onReplyClick instanceof Function)
      props.onReplyClick(item, index, event);
  };

  const onReplyMessageClick: MessageListEvent = (item, index, event) => {
    if (props.onReplyMessageClick instanceof Function)
      props.onReplyMessageClick(item, index, event);
  };

  const onRemoveMessageClick: MessageListEvent = (item, index, event) => {
    if (props.onRemoveMessageClick instanceof Function)
      props.onRemoveMessageClick(item, index, event);
  };

  const onContextMenu: MessageListEvent = (item, index, event) => {
    if (props.onContextMenu instanceof Function)
      props.onContextMenu(item, index, event);
  };

  const onMessageFocused: MessageListEvent = (item, index, event) => {
    if (props.onMessageFocused instanceof Function)
      props.onMessageFocused(item, index, event);
  };

  const onMeetingMessageClick: MessageListEvent = (item, index, event) => {
    if (props.onMeetingMessageClick instanceof Function)
      props.onMeetingMessageClick(item, index, event);
  };

  const onScroll = (e: React.UIEvent<HTMLElement>): void => {
    // const bottom = getBottom(e.currentTarget);
    // setScrollBottom(bottom);
    // if (
    //   toBottomHeight === '100%' ||
    //   (toBottomHeight && bottom > toBottomHeight)
    // ) {
    //   if (_downButton !== true) {
    //     setDownButton(true);
    //     setScrollBottom(bottom);
    //   }
    // } else if (_downButton !== false) {
    //   setDownButton(false);
    //   setScrollBottom(bottom);
    // }
    // if (props.onScroll instanceof Function) {
    //   props.onScroll(e);
    // }
  };

  const toBottom = (e: any) => {
    if (!referance) return;
    referance.current.scrollTop = referance.current.scrollHeight;
    if (props.onDownButtonClick instanceof Function) {
      props.onDownButtonClick(e);
    }
  };

  const onMeetingMoreSelect: MessageListEvent = (item, i, e) => {
    if (props.onMeetingMoreSelect instanceof Function)
      props.onMeetingMoreSelect(item, i, e);
  };

  const onMeetingLinkClick: MessageListEvent = (item, i, e) => {
    if (props.onMeetingLinkClick instanceof Function)
      props.onMeetingLinkClick(item, i, e);
  };

  // onFocus, copy innerText to clipboard using navigator.clipboard
  const onFocus = useCallback((e: React.FocusEvent<HTMLDivElement>) => {
    // smooth scroll to focused element
    const element = e.currentTarget;
    element.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
      inline: 'center',
    });
  }, []);

  const onCopy = (e: React.ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const text = e.currentTarget.innerText;
    navigator.clipboard.writeText(text);
  };

  return (
    <div
      className={classNames(['rce-container-mlist', props.className])}
      // eslint-disable-next-line react/jsx-props-no-spreading
      {...props.customProps}
    >
      {!!props.children && props.isShowChild && props.children}
      <div ref={referance} onScroll={onScroll} className="rce-mlist">
        {props.dataSource.map((x, i: number, array) => {
          // eslint-disable-next-line react/no-danger
          const text = (
            <div
              tabIndex={array.length - i}
              onFocus={onFocus}
              onCopy={onCopy}
              dangerouslySetInnerHTML={{
                __html: x.text,
              }}
            />
          );

          return (
            <MessageBox
              key={i as Key}
              // eslint-disable-next-line react/jsx-props-no-spreading
              {...(x as any)}
              text={text || x?.text}
              // data={x}

              onOpen={
                props.onOpen &&
                ((e: React.MouseEvent<HTMLElement>) => onOpen(x, i, e))
              }
              onPhotoError={
                props.onPhotoError &&
                ((e: React.MouseEvent<HTMLElement>) => onPhotoError(x, i, e))
              }
              onDownload={
                props.onDownload &&
                ((e: React.MouseEvent<HTMLElement>) => onDownload(x, i, e))
              }
              onTitleClick={
                props.onTitleClick &&
                ((e: React.MouseEvent<HTMLElement>) => onTitleClick(x, i, e))
              }
              onForwardClick={
                props.onForwardClick &&
                ((e: React.MouseEvent<HTMLElement>) => onForwardClick(x, i, e))
              }
              onReplyClick={
                props.onReplyClick &&
                ((e: React.MouseEvent<HTMLElement>) => onReplyClick(x, i, e))
              }
              onReplyMessageClick={
                props.onReplyMessageClick &&
                ((e: React.MouseEvent<HTMLElement>) =>
                  onReplyMessageClick(x, i, e))
              }
              onRemoveMessageClick={
                props.onRemoveMessageClick &&
                ((e: React.MouseEvent<HTMLElement>) =>
                  onRemoveMessageClick(x, i, e))
              }
              onClick={
                props.onClick &&
                ((e: React.MouseEvent<HTMLElement>) => onClick(x, i, e))
              }
              onContextMenu={
                props.onContextMenu &&
                ((e: React.MouseEvent<HTMLElement>) => onContextMenu(x, i, e))
              }
              onMeetingMoreSelect={
                props.onMeetingMoreSelect &&
                ((e: React.MouseEvent<HTMLElement>) =>
                  onMeetingMoreSelect(x, i, e))
              }
              onMessageFocused={
                props.onMessageFocused &&
                ((e: React.MouseEvent<HTMLElement>) =>
                  onMessageFocused(x, i, e))
              }
              onMeetingMessageClick={
                props.onMeetingMessageClick &&
                ((e: React.MouseEvent<HTMLElement>) =>
                  onMeetingMessageClick(x, i, e))
              }
              onMeetingTitleClick={props.onMeetingTitleClick}
              onMeetingVideoLinkClick={props.onMeetingVideoLinkClick}
              onMeetingLinkClick={
                props.onMeetingLinkClick &&
                ((e: React.MouseEvent<HTMLElement>) =>
                  onMeetingLinkClick(x, i, e))
              }
              actionButtons={props.actionButtons}
              styles={props.messageBoxStyles}
              notchStyle={props.notchStyle}
            />
          );
        })}
      </div>
      {downButton === true && _downButton && toBottomHeight !== '100%' && (
        // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
        <div className="rce-mlist-down-button" onClick={toBottom}>
          <FaChevronDown />
          {props.downButtonBadge !== undefined ? (
            <span className="rce-mlist-down-button--badge">
              {props.downButtonBadge.toString()}
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
};

export function Chat() {
  // Ref for the input
  const inputRef = React.useRef<HTMLInputElement>(null);
  const messagesRef = React.useRef<HTMLDivElement>(null);

  // Create currentMessage state
  const [currentMessage, setCurrentMessage] = useAtom(inputAtom);

  // Create messages state array
  const [messages, setMessages] = useAtom(chatMessagesAtom);

  const submitMessage = useSetAtom(chatMessageSubmitAtom);
  const [placeholder] = useAtom(placeholderAtom);
  const [channel] = useAtom(channelAtom);

  useEffect(() => {
    // Focus the input when the component mounts
    if (inputRef.current) {
      inputRef.current.focus();
      // set the tabindex of the input to 0
      inputRef.current.tabIndex = 0;
    }
  }, []);

  // Create onSubmit handler
  const onSubmit = useCallback(
    (e: any) => {
      e.preventDefault();
      setMessages([
        ...messages,
        {
          position: 'right',
          type: 'text',
          text: currentMessage,
        },
      ]);
      submitMessage(currentMessage);
      setCurrentMessage('');
      e.currentTarget.value = '';
    },
    [currentMessage, messages, setCurrentMessage, setMessages, submitMessage]
  );

  // state for cursor position
  const [cursorPosition, setCursorPosition] = useState(0);

  // Create onKeyDown handler
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      // return if any modifier keys are pressed
      if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) {
        return;
      }
      // Check if the user pressed the Enter key
      if (e.key === 'Enter') {
        onSubmit(e as any);
      }
    },
    [onSubmit]
  );

  const onKeyUp = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    // set the cursor position
    setCursorPosition(e.currentTarget.selectionStart || 0);
  }, []);

  const onChatKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      // if cursorPosition is not 0, return
      if (cursorPosition !== 0) {
        return;
      }

      // if copy keyboard shortcut is pressed, then copy the innerText of the focused element
      if (e.key === 'c' && (e.ctrlKey || e.metaKey)) {
        const text = document.activeElement?.innerText;
        if (text) {
          navigator.clipboard.writeText(text);
        }
        return;
      }

      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const direction = e.key === 'ArrowUp' ? 1 : -1;
        // get tabIndex of the active element
        const i = document.activeElement?.tabIndex || 0;

        let newIndex = i + direction;
        if (newIndex > messages.length) {
          inputRef.current?.focus();
          channel(Channel.ITEM_FOCUSED, { index: -1 });
          return;
        }

        if (newIndex < 0) {
          newIndex = messages.length;
        }
        // if new index is less than 0, set it to the tabIndex of the last message

        const element = document.querySelector(
          `[tabindex="${newIndex}"]`
        ) as HTMLInputElement;
        if (element) {
          element?.focus();
          const focusIndex = messages.length - newIndex;
          channel(Channel.ITEM_FOCUSED, { index: focusIndex });
        }
        // else if not a modifier key, focus the input
      } else if (!e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
        inputRef.current?.focus();
      }
    },
    [channel, cursorPosition, messages.length]
  );

  const onFocus = () => {
    // Scroll messagesRef to the bottom
    messagesRef.current?.scrollTo({
      top: messagesRef.current.scrollHeight,
      behavior: 'smooth',
    });
  };

  // when messages changes, scroll to the bottom
  useEffect(() => {
    const element = document.querySelector('.kit-chat-messages > .rce-mlist');

    if (element) {
      // smooth scroll to the bottom
      element.scrollTo({
        top: element.scrollHeight,
        behavior: 'smooth',
      });
    }
  }, [messages]);

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      className="chat-container flex flex-col h-full w-full"
      onKeyDown={onChatKeyDown}
    >
      <ChatList
        referance={messagesRef}
        dataSource={messages as MessageType[]}
        className="kit-chat-messages"
        toBottomHeight="100%"
        notchStyle={{ display: 'none' }}
        // Copy the content of the message on click
        onClick={(e: any) => {
          navigator.clipboard.writeText(e.text);
        }}
      />
      <Input
        referance={inputRef}
        className="kit-chat-input"
        inputStyle={{ fontSize: '1rem' }}
        placeholder={placeholder}
        rightButtons={
          <Button
            className="kit-chat-submit"
            backgroundColor=""
            color=""
            text="⏎"
            onClick={onSubmit}
          />
        }
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onChange={(e: any) => setCurrentMessage(e.target.value)}
        onFocus={onFocus}
      />
    </div>
  );
}
