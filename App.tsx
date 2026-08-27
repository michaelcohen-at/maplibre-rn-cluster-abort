import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import { GeoJSONSource, Layer, Map } from '@maplibre/maplibre-react-native';
import type { Feature, FeatureCollection } from 'geojson';
import { useEffect, useState } from 'react';
import { SafeAreaView, StyleSheet, Text, View } from 'react-native';

/**
 * Bisecting harness for a native abort in a clustered `<GeoJSONSource>`.
 *
 * The source below stays mounted with `cluster` ENABLED throughout, and only its
 * `data` prop changes — which is what an app does when it swaps the contents of
 * a clustered layer. Each step logs `[repro] step N` BEFORE it renders, so the
 * last line in the log names the payload that killed the process.
 *
 * A crash here is unrecoverable and invisible to JS: the throw happens in C++
 * inside supercluster, crosses an Objective-C++ boundary with no handler, and
 * becomes SIGABRT. No error boundary, no redbox.
 */

/** No network and no glyphs: a background plus circle layers only. */
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

const SOURCE_ID = 'repro-source';

/** N valid Points, offset so each step is visibly different data. */
function points(n: number, shift = 0): Feature[] {
	return Array.from({ length: n }, (_, i) => ({
		type: 'Feature' as const,
		properties: { value: i, label: `t${i}` },
		geometry: {
			type: 'Point' as const,
			coordinates: [
				18.4 + (i % 5) * 0.02 + shift,
				-33.95 + Math.floor(i / 5) * 0.02
			]
		}
	}));
}

const fc = (features: Feature[]): FeatureCollection => ({
	type: 'FeatureCollection',
	features
});

/** A feature with an explicitly null geometry — legal GeoJSON (RFC 7946 §3.2). */
const NULL_GEOMETRY = {
	type: 'Feature',
	properties: { value: 1, label: 'null-geom' },
	geometry: null
} as unknown as Feature;

const MULTI_POINT: Feature = {
	type: 'Feature',
	properties: { value: 2, label: 'multi' },
	geometry: {
		type: 'MultiPoint',
		coordinates: [
			[18.44, -33.95],
			[18.46, -33.93]
		]
	}
};

const POLYGON: Feature = {
	type: 'Feature',
	properties: { value: 3, label: 'poly' },
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
};

/**
 * Each step keeps `cluster` enabled and only swaps `data`. Ordered cheapest
 * hypothesis first, so the last logged step is the culprit.
 */
const STEPS: { name: string; data: FeatureCollection }[] = [
	{ name: '0 baseline: 20 Points', data: fc(points(20)) },
	// Swapping Points for other Points is fine — this step always survives, and
	// rules out "replacing a clustered source's data" being the problem on its own.
	{ name: '1 swap to 12 different Points', data: fc(points(12, 0.05)) },
	// One feature with `geometry: null` — legal GeoJSON (RFC 7946 section 3.2).
	// THIS is the step that aborts the process.
	{
		name: '2 Points + ONE null-geometry feature',
		data: fc([...points(8), NULL_GEOMETRY])
	},
	// Never reached; kept so the harness can be re-pointed at other shapes.
	{ name: '3 Points + ONE MultiPoint', data: fc([...points(8, 0.02), MULTI_POINT]) },
	{ name: '4 Points + ONE Polygon', data: fc([...points(8, 0.04), POLYGON]) }
];

/**
 * Matches the cluster aggregation a real app uses — `accumulated` reducers, not
 * just clusterRadius. Included because it changes which supercluster code path
 * runs when the data is replaced.
 */
const CLUSTER_PROPERTIES = {
	clusterSum: [
		['+', ['accumulated'], ['get', 'clusterSum']],
		['coalesce', ['get', 'value'], 0]
	],
	clusterObserved: [
		['+', ['accumulated'], ['get', 'clusterObserved']],
		['case', ['>', ['coalesce', ['get', 'value'], -1], -1], 1, 0]
	]
};

const STEP_MS = 2500;

export default function App() {
	const [step, setStep] = useState(0);
	const [styleLoaded, setStyleLoaded] = useState(false);

	// Self-driving: advance through the payloads once the style is up. The log
	// line is emitted before the state change so it is flushed ahead of the
	// native mount that may abort.
	useEffect(() => {
		if (!styleLoaded || step >= STEPS.length - 1) return;
		const t = setTimeout(() => {
			const next = step + 1;
			console.log(`[repro] step ${STEPS[next].name}`);
			setStep(next);
		}, STEP_MS);
		return () => clearTimeout(t);
	}, [styleLoaded, step]);

	useEffect(() => {
		if (styleLoaded) console.log(`[repro] step ${STEPS[0].name}`);
	}, [styleLoaded]);

	const current = STEPS[step];

	return (
		<SafeAreaView style={styles.root}>
			<View style={styles.bar}>
				<Text style={styles.title}>maplibre-react-native cluster abort</Text>
				<Text style={styles.line}>
					step <Text style={styles.mono}>{current.name}</Text>
				</Text>
				<Text style={styles.line}>
					features <Text style={styles.mono}>{current.data.features.length}</Text>
					{'   '}cluster <Text style={styles.mono}>true (never changes)</Text>
				</Text>
				<Text style={styles.line}>
					style loaded <Text style={styles.mono}>{String(styleLoaded)}</Text>
				</Text>
			</View>

			<Map
				style={styles.map}
				mapStyle={MAP_STYLE}
				attribution={false}
				compass={false}
				logo={false}
				onDidFinishLoadingStyle={() => setStyleLoaded(true)}
			>
				<GeoJSONSource
					id={SOURCE_ID}
					data={current.data}
					cluster
					clusterRadius={20}
					clusterProperties={CLUSTER_PROPERTIES as never}
				>
					<Layer
						id="repro-cluster-circle"
						type="circle"
						paint={{ 'circle-radius': 12, 'circle-color': '#3399cc' }}
					/>
					<Layer
						id="repro-cluster-count"
						type="circle"
						filter={['has', 'point_count']}
						paint={{ 'circle-radius': 16, 'circle-color': '#2b6cb0' }}
					/>
				</GeoJSONSource>
			</Map>
		</SafeAreaView>
	);
}

const styles = StyleSheet.create({
	root: { flex: 1, backgroundColor: '#101418' },
	bar: { padding: 12, gap: 3 },
	title: { color: '#fff', fontSize: 15, fontWeight: '700', marginBottom: 4 },
	line: { color: '#c8cdd4', fontSize: 12 },
	mono: { fontFamily: 'Menlo', color: '#7fd1b9', fontSize: 11 },
	map: { flex: 1 }
});
