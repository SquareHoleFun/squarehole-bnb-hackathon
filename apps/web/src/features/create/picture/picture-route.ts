/** SH-251: the picture way's place among Create's routes: `/create/v2-picture`, beside the six steps' `/create/v2-<step>`. */
export const PICTURE_STEP = 'v2-picture';
export type PictureStep = typeof PICTURE_STEP;
export const PICTURE_PATH = `/create/${PICTURE_STEP}`;
export const isPictureStep = (value: string | undefined): value is PictureStep => value === PICTURE_STEP;
