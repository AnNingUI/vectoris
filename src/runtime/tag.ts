export type Tag<T, Name extends string> = T & {
	name: Name;
};
