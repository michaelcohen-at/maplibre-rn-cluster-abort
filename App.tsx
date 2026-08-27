import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import { Camera, GeoJSONSource, Layer, Map } from '@maplibre/maplibre-react-native';
import type { Feature, FeatureCollection } from 'geojson';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import {
	LogBox,
	Pressable,
	SafeAreaView,
	StyleSheet,
	Text,
	View
} from 'react-native';

// MapLibre's own deprecation notice (automaticallyAdjustsScrollViewInsets), not
// part of this bug; keep it out of the LogBox so recordings show only the repro.
LogBox.ignoreLogs([/automaticallyAdjustsScrollViewInsets/]);

/**
 * Minimal reproduction of a native abort caused by Fabric view recycling in
 * `<GeoJSONSource>`.
 *
 *   1. Mount a CLUSTERED source with Point data.                 (fine)
 *   2. Unmount it. Its component view goes to Fabric's recycle pool.
 *   3. Mount a DIFFERENT, non-clustered source with a Polygon.   <- SIGABRT
 *
 * Step 3 dequeues the recycled view from step 1. `MLRNGeoJSONSourceComponentView`
 * does not implement `prepareForRecycle`, so the view still owns the previous
 * `MLRNGeoJSONSource`, whose `source` property still points at the OLD, still-
 * clustered `MLNShapeSource` (`removeFromMap` never nils it). `updateProps`
 * pushes the new `data` first, `setShape:` sees `self.source != nil`, and the
 * polygon is fed to supercluster — which requires Points and throws
 * `bad_variant_access` from C++. That crosses an ObjC++ boundary with no handler
 * and becomes std::terminate → SIGABRT. Nothing in JS can catch it.
 *
 * The CONTROL runs the same three steps in the opposite order. The recycled
 * view then carries a stale but ordinary source, points are pushed into it
 * harmlessly, and the app survives. The only difference between the two runs is
 * which source was mounted first.
 *
 * Both sources have valid GeoJSON and correct props. The polygon source never
 * asks for clustering. Different ids, different keys — they are unrelated
 * components that happen to share a native view class.
 */

const MAP_STYLE: StyleSpecification = {
	version: 8 as const,
	name: 'blank',
	sources: {},
	layers: [
		{
			id: 'background',
			type: 'background',
			paint: { 'background-color': '#d8dbe0' }
		}
	]
};

const POINTS: FeatureCollection = {
	type: 'FeatureCollection',
	features: Array.from({ length: 20 }, (_, i): Feature => ({
		type: 'Feature',
		properties: { value: i },
		geometry: {
			type: 'Point',
			coordinates: [18.4 + (i % 5) * 0.02, -33.95 + Math.floor(i / 5) * 0.02]
		}
	}))
};

const POLYGON: FeatureCollection = {
	type: 'FeatureCollection',
	features: [
		{
			type: 'Feature',
			properties: { name: 'a block' },
			geometry: {
				type: 'Polygon',
				coordinates: [
					[
						[18.36, -34.0],
						[18.56, -34.0],
						[18.56, -33.86],
						[18.36, -33.86],
						[18.36, -34.0]
					]
				]
			}
		}
	]
};

/** Real-world cluster aggregation (`accumulated` reducers), as an app would use. */
const CLUSTER_PROPERTIES = {
	sum: [
		['+', ['accumulated'], ['get', 'sum']],
		['coalesce', ['get', 'value'], 0]
	]
};

/** A clustered point source — think "pest traps". */
function ClusteredPoints() {
	return (
		<GeoJSONSource
			key="traps"
			id="traps"
			data={POINTS}
			cluster
			clusterRadius={20}
			clusterProperties={CLUSTER_PROPERTIES as never}
		>
			<Layer
				id="traps-circle"
				type="circle"
				paint={{ 'circle-radius': 12, 'circle-color': '#3399cc' }}
			/>
		</GeoJSONSource>
	);
}

/** An ordinary polygon source — think "field blocks". No clustering. */
function PlainPolygon() {
	return (
		<GeoJSONSource key="blocks" id="blocks" data={POLYGON}>
			<Layer
				id="blocks-fill"
				type="fill"
				paint={{ 'fill-color': '#cc3333', 'fill-opacity': 0.5 }}
			/>
		</GeoJSONSource>
	);
}

type Step = { name: string; render: () => ReactNode };
type Mode = 'idle' | 'repro' | 'control' | 'remount';

const SEQUENCES: Record<Exclude<Mode, 'idle'>, Step[]> = {
	// The SAME clustered source unmounts and remounts under the SAME id — what a
	// data-driven layer does when it renders null while its next payload loads.
	// Passes on the unpatched library. It exists to guard the fix: a
	// prepareForRecycle that recreates the wrapper but leaves `_props` alone never
	// re-applies an unchanged `id` (Fabric passes oldProps:nullptr on Create and
	// updateProps diffs against `_props`), so addToMap gets a nil id and segfaults
	// in strlen. See the fix branch for the correct reset.
	remount: [
		{ name: '0 mount CLUSTERED source, 20 Points', render: () => <ClusteredPoints /> },
		{ name: '1 unmount it (view -> recycle pool)', render: () => null },
		{ name: '2 mount the SAME clustered source again', render: () => <ClusteredPoints /> },
		{ name: '3 survived', render: () => <ClusteredPoints /> }
	],
	// Clustered first: the recycled view's stale source is CLUSTERED, so the
	// polygon reaches supercluster. Aborts at step 2.
	repro: [
		{ name: '0 mount CLUSTERED source, 20 Points', render: () => <ClusteredPoints /> },
		{ name: '1 unmount it (view -> recycle pool)', render: () => null },
		{ name: '2 mount PLAIN source, 1 Polygon  <- SIGABRT here', render: () => <PlainPolygon /> },
		{ name: '3 survived — bug NOT reproduced', render: () => <PlainPolygon /> }
	],
	// Plain first: the stale source is an ordinary one, so pushing points into
	// it is harmless. Survives.
	control: [
		{ name: '0 mount PLAIN source, 1 Polygon', render: () => <PlainPolygon /> },
		{ name: '1 unmount it (view -> recycle pool)', render: () => null },
		{ name: '2 mount CLUSTERED source, 20 Points', render: () => <ClusteredPoints /> },
		{ name: '3 survived, as expected', render: () => <ClusteredPoints /> }
	]
};

const STEP_MS = 2500;

/**
 * Optional hands-free mode for CI or a maintainer verifying a fix:
 *   EXPO_PUBLIC_AUTORUN=repro npx expo start   # starts the repro once the style loads
 *   EXPO_PUBLIC_AUTORUN=control npx expo start
 * Inlined at bundle time, so restart metro after changing it.
 */
const AUTORUN = process.env.EXPO_PUBLIC_AUTORUN as Exclude<Mode, 'idle'> | undefined;

export default function App() {
	const [mode, setMode] = useState<Mode>('idle');
	const [step, setStep] = useState(0);
	const [styleLoaded, setStyleLoaded] = useState(false);

	const steps = mode === 'idle' ? null : SEQUENCES[mode];

	useEffect(() => {
		if (styleLoaded && mode === 'idle' && AUTORUN && AUTORUN in SEQUENCES) {
			console.log(`[repro] autorun=${AUTORUN}`);
			console.log(`[repro] ${AUTORUN} step ${SEQUENCES[AUTORUN][0].name}`);
			setStep(0);
			setMode(AUTORUN);
		}
	}, [styleLoaded, mode]);

	// A run is self-driving once started. Each step is logged BEFORE the state
	// change so the log line is flushed ahead of the native commit that may
	// abort: the last `[repro]` line in the device log names the fatal step.
	useEffect(() => {
		if (!steps || step >= steps.length - 1) return;
		const t = setTimeout(() => {
			const next = step + 1;
			console.log(`[repro] ${mode} step ${steps[next].name}`);
			setStep(next);
		}, STEP_MS);
		return () => clearTimeout(t);
	}, [mode, steps, step]);

	const start = (next: Exclude<Mode, 'idle'>) => {
		console.log(`[repro] ${next} step ${SEQUENCES[next][0].name}`);
		setStep(0);
		setMode(next);
	};

	const current = steps?.[step];

	return (
		<SafeAreaView style={styles.root}>
			<View style={styles.bar}>
				<Text style={styles.title}>maplibre-react-native: recycled clustered source</Text>
				<Text style={styles.line}>
					style loaded <Text style={styles.mono}>{String(styleLoaded)}</Text>
					{'   '}mode <Text style={styles.mono}>{mode}</Text>
				</Text>
				<Text style={styles.line}>
					step{' '}
					<Text style={styles.mono}>{current ? current.name : '— press a button —'}</Text>
				</Text>
				<View style={styles.buttons}>
					<Pressable
						style={[styles.button, styles.danger, !styleLoaded && styles.disabled]}
						disabled={!styleLoaded}
						onPress={() => start('repro')}
					>
						<Text style={styles.buttonText}>Run repro (crashes)</Text>
					</Pressable>
					<Pressable
						style={[styles.button, !styleLoaded && styles.disabled]}
						disabled={!styleLoaded}
						onPress={() => start('control')}
					>
						<Text style={styles.buttonText}>Run control (survives)</Text>
					</Pressable>
					<Pressable
						style={[styles.button, !styleLoaded && styles.disabled]}
						disabled={!styleLoaded}
						onPress={() => start('remount')}
					>
						<Text style={styles.buttonText}>Run remount (same id)</Text>
					</Pressable>
					<Pressable style={[styles.button, styles.muted]} onPress={() => setMode('idle')}>
						<Text style={styles.buttonText}>Reset</Text>
					</Pressable>
				</View>
			</View>

			<Map
				style={styles.map}
				mapStyle={MAP_STYLE}
				attribution={false}
				compass={false}
				logo={false}
				onDidFinishLoadingStyle={() => setStyleLoaded(true)}
			>
				{/* Frame the data so each step's render is visible; not part of the bug. */}
				<Camera initialViewState={{ center: [18.46, -33.93], zoom: 10 }} />
				{current ? current.render() : null}
			</Map>
		</SafeAreaView>
	);
}

const styles = StyleSheet.create({
	root: { flex: 1, backgroundColor: '#101418' },
	bar: { padding: 12, gap: 4 },
	title: { color: '#fff', fontSize: 14, fontWeight: '700', marginBottom: 4 },
	line: { color: '#c8cdd4', fontSize: 12 },
	mono: { fontFamily: 'Menlo', color: '#7fd1b9', fontSize: 11 },
	buttons: { flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' },
	button: {
		backgroundColor: '#2b6cb0',
		paddingVertical: 8,
		paddingHorizontal: 12,
		borderRadius: 6
	},
	danger: { backgroundColor: '#c53030' },
	muted: { backgroundColor: '#4a5568' },
	disabled: { opacity: 0.4 },
	buttonText: { color: '#fff', fontSize: 12, fontWeight: '600' },
	map: { flex: 1 }
});
