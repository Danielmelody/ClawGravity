export type {
    PlatformType,
    PlatformId,
    PlatformUser,
    PlatformChannel,
    PlatformAttachment,
    PlatformMessage,
    RichContent,
    RichContentField,
    ButtonStyle,
    ButtonDef,
    SelectMenuOption,
    SelectMenuDef,
    ComponentDef,
    ComponentRow,
    FileAttachment,
    MessagePayload,
    PlatformSentMessage,
    PlatformButtonInteraction,
    PlatformSelectInteraction,
    PlatformCommandInteraction,
} from './types';

export { toPlatformKey, fromPlatformKey } from './types';

export type {
    PlatformAdapterEvents,
    PlatformAdapter,
} from './adapter';

export {
    createRichContent,
    withTitle,
    withDescription,
    withColor,
    addField,
    withFields,
    withFooter,
    withTimestamp,
    withThumbnail,
    withImage,
    pipe,
} from './richContentBuilder';
