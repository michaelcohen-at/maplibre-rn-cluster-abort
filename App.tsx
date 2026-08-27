import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import { GeoJSONSource, Layer, Map } from '@maplibre/maplibre-react-native';
import type { FeatureCollection } from 'geojson';
import { useEffect, useState } from 'react';
import {
	SafeAreaView,
	StyleSheet,
	Text,
	TouchableOpacity,
	View
} from 'react-native';

/**
 * Minimal reproduction: a `<GeoJSONSource>` mounted with `cluster` enabled keeps
 * clustering natively after `cluster` is set back to false, and the next `data`
 * push is fed to maplibre's supercluster. Any non-Point geometry then aborts the
 * process (SIGABRT) from C++ — it is not catchable from JS.
 *
 * Every feature below is valid GeoJSON. The polygon is rendered by a source
 * whose props say `cluster={false}`, so nothing here asks for a clustered
 * polygon source.
 *
 * See README.md for the lines in the iOS implementation that cause it.
 */

/** No network and no glyphs: a background plus circle/fill layers only. */
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

/**
 * The SAME source id in both phases. The component is never unmounted — React
 * only updates its props — so this is the plainest possible prop update.
 */
const SOURCE_ID = 'repro-source';

/** 20 valid Points. */
const POINTS: FeatureCollection = {
	type: 'FeatureCollection',
	features: Array.from({ length: 20 }, (_, i) => ({
		type: 'Feature',
		properties: { value: i },
		geometry: {
			type: 'Point',
			coordinates: [18.4 + (i % 5) * 0.02, -33.95 + Math.floor(i / 5) * 0.02]
		}
	}))
};

/** ONE valid Polygon, rendered by a source with `cluster={false}`. */
const POLYGONS: FeatureCollection = {
	type: 'FeatureCollection',
	features: [
		{
			type: 'Feature',
			properties: { name: 'a polygon' },
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

type Phase = 'clustered-points' | 'plain-polygons';

export default function App() {
	const [phase, setPhase] = useState<Phase>('clustered-points');
	const [styleLoaded, setStyleLoaded] = useState(false);
	const [armed, setArmed] = useState(true);

	// Self-driving, so reproducing means only launching the app: once the style
	// is loaded and the clustered source exists natively, flip to the
	// non-clustered polygon source. The process aborts during that commit.
	useEffect(() => {
		if (!styleLoaded || !armed || phase !== 'clustered-points') return;
		const t = setTimeout(() => {
			console.log(
				'[repro] switching to cluster={false} + Polygon data — expect SIGABRT'
			);
			setPhase('plain-polygons');
		}, 3000);
		return () => clearTimeout(t);
	}, [styleLoaded, armed, phase]);

	const clustered = phase === 'clustered-points';

	return (
		<SafeAreaView style={styles.root}>
			<View style={styles.bar}>
				<Text style={styles.title}>maplibre-react-native cluster abort</Text>
				<Text style={styles.line}>
					phase: <Text style={styles.mono}>{phase}</Text>
				</Text>
				<Text style={styles.line}>
					props: <Text style={styles.mono}>cluster={String(clustered)}</Text>
					{'   '}
					<Text style={styles.mono}>
						data={clustered ? '20 x Point' : '1 x Polygon'}
					</Text>
				</Text>
				<Text style={styles.line}>
					style loaded: <Text style={styles.mono}>{String(styleLoaded)}</Text>
				</Text>
				<View style={styles.buttons}>
					<TouchableOpacity
						style={styles.button}
						onPress={() => setPhase('plain-polygons')}
					>
						<Text style={styles.buttonText}>Switch now</Text>
					</TouchableOpacity>
					<TouchableOpacity
						style={[styles.button, !armed && styles.buttonOff]}
						onPress={() => setArmed((a) => !a)}
					>
						<Text style={styles.buttonText}>auto: {armed ? 'on' : 'off'}</Text>
					</TouchableOpacity>
					<TouchableOpacity
						style={styles.button}
						onPress={() => setPhase('clustered-points')}
					>
						<Text style={styles.buttonText}>Reset</Text>
					</TouchableOpacity>
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
				{/*
				  One source, one id, one component instance. Only `data` and
				  `cluster` differ between phases.

				  phase 1 -> cluster: true,  data: Points  (renders clusters)
				  phase 2 -> cluster: false, data: Polygon (aborts)

				  In phase 2 the props ask for a NON-clustered source, but the
				  native MLNShapeSource created in phase 1 still has clustering
				  enabled, and MLRNGeoJSONSourceComponentView applies `data`
				  BEFORE `cluster`. The polygon reaches supercluster, whose Zoom
				  ctor calls geometry.get<point<double>>() on every feature and
				  throws bad_variant_access -> std::terminate -> SIGABRT.
				*/}
				<GeoJSONSource
					id={SOURCE_ID}
					data={clustered ? POINTS : POLYGONS}
					cluster={clustered}
					clusterRadius={20}
				>
					<Layer
						id="repro-circles"
						type="circle"
						paint={{ 'circle-radius': 12, 'circle-color': '#3399cc' }}
					/>
					<Layer
						id="repro-fill"
						type="fill"
						paint={{ 'fill-color': '#cc3333', 'fill-opacity': 0.5 }}
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
	buttons: { flexDirection: 'row', gap: 8, marginTop: 10 },
	button: {
		backgroundColor: '#2b6cb0',
		paddingVertical: 8,
		paddingHorizontal: 12,
		borderRadius: 6
	},
	buttonOff: { backgroundColor: '#4a5568' },
	buttonText: { color: '#fff', fontSize: 12, fontWeight: '600' },
	map: { flex: 1 }
});
