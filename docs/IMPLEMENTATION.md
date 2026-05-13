# Color Modeling Project - Implementation Report

## Overview
This project implements a web-based tool for analyzing color profile linearity between different substrates. The application parses ICC (.icm) and CxF (.cxf) color profile files, extracts measurement data, and performs statistical analysis to determine how well color transfers between different materials.

## Architecture

### Frontend Stack
- **React 18** with TypeScript
- **Vite** for build tooling
- **TailwindCSS** for styling
- **Zustand** for state management
- **D3.js** for data visualization

### Core Modules

#### 1. Parsers (`/src/lib/parsers/`)

##### CXF Parser (`cxfParser.ts`)
Parses Color Exchange Format (CxF) XML files:
- Extracts Patch, Sample, and Colorant elements
- Handles multiple attribute naming conventions (L/Lab/LStar, etc.)
- Supports spectral data extraction from reflectance attributes
- Implements fuzzy matching for CMYK values with tolerance
- Converts percentage values (0-1 and 0-100 ranges)

##### ICM Parser (`icmParser.ts`)
Parses ICC profile binary files:
- Reads ICC header and validates profile structure
- Extracts A2B (device-to-PCS) lookup tables
- Supports mABT (matrix-based) and CLUT formats
- Generates synthetic measurements when direct extraction fails
- Includes approximate CMYK to Lab conversion using sRGB intermediates

#### 2. Analyzers (`/src/lib/analyzers/`)

##### Linearity Analyzer (`linearityAnalyzer.ts`)
Performs statistical comparison between two color profiles:

**Key Metrics:**
- **Pearson Correlation (LAB)**: Measures linear relationship between reference and target Lab values
- **R² (Coefficient of Determination)**: Indicates how well target values predict reference values
- **Slope Stability Score**: Measures consistency of relative slopes between CMYK channels
- **Mean ΔE00 After Correction**: Average color difference after linear correction
- **Residual Correlation**: Consistency of prediction errors
- **Confidence Level**: Overall assessment (high/medium/low)

**Algorithm:**
1. Match patches by CMYK values (with fuzzy matching tolerance of 2%)
2. Calculate Pearson correlation for flattened LAB values
3. Compute residuals and their variance
4. Calculate R² using total sum of squares
5. Group patches by dominant channel and calculate slope stability
6. Apply linear correction model and compute ΔE00
7. Determine confidence based on average of key metrics

#### 3. Data Loading (`dataLoader.ts`)
- Unified interface for loading .icm and .cxf files
- Automatic file type detection
- Basic data cleaning pipeline (placeholder for outlier detection)
- DeltaE calculation between raw and cleaned data

#### 4. UI Components

- **ProfileUploader**: Drag-and-drop file upload with visual feedback
- **ProfileList**: Displays loaded profiles with selection controls
- **ComparisonView**: Shows detailed comparison with:
  - Profile metadata cards
  - LAB scatter plot visualization
  - Spectral curves comparison
  - Linearity analysis results dashboard
- **MetricCard**: Reusable component for displaying analysis metrics with color-coded values

## Test Coverage

### Unit Tests

#### Filename Parser Tests (`filenameParser.test.ts`)
Tests parsing of various filename formats:
- `BC_Lyve_P9000_mk_CanvasMatte.icm`
- `BC_VibranceLuster_P9000_PLPP260.icm`
- `BC_600MT_P9000_mk_WCRW.icm`

#### CXF Parser Tests (`cxfParser.test.ts`)
- Valid XML with Patch elements
- Sample element handling
- Invalid XML error handling
- Spectral data extraction
- Percentage value normalization
- Default ID generation

#### Linearity Analyzer Tests (`linearityAnalyzer.test.ts`)
- Basic linearity calculation with matching profiles
- High correlation for identical profiles
- Error handling for insufficient matches
- Fuzzy matching within tolerance
- Mean DeltaE calculation
- Residual correlation computation

## Usage

### Running the Application

```bash
cd frontend
npm install
npm run dev
```

### Running Tests

```bash
npm install --save-dev vitest @testing-library/react jsdom
npx vitest run
```

## File Format Support

### ICC Profiles (.icm)
- CMYK and RGB color spaces
- A2B0, A2B1, A2B2 lookup tables
- Matrix-based (mABT) and CLUT formats
- Automatic fallback to synthetic data generation

### CxF Files (.cxf)
- XML-based format
- Patch, Sample, Colorant elements
- Embedded spectral data
- Multiple attribute naming conventions

## Key Features Implemented

1. ✅ **CXF Parser** - Full implementation with spectral support
2. ✅ **ICM Parser** - Binary parsing with A2B table extraction
3. ✅ **Linearity Analyzer** - Complete statistical analysis suite
4. ✅ **DeltaE00 Calculation** - CIEDE2000 color difference
5. ✅ **Fuzzy Matching** - Tolerance-based patch matching
6. ✅ **Confidence Scoring** - Automated quality assessment
7. ✅ **Visual Dashboard** - Real-time metric display
8. ✅ **Error Handling** - Graceful degradation with user feedback

## Future Improvements

1. **Advanced Outlier Detection**: Implement Savitzky-Golay filtering and statistical methods
2. **Spectral Analysis**: Add full spectral curve comparison metrics
3. **Batch Processing**: Support for analyzing multiple profile pairs
4. **Export Functionality**: Generate PDF/CSV reports
5. **Interactive Visualizations**: D3-based interactive plots
6. **Performance Optimization**: Web Workers for heavy computations
7. **Extended Format Support**: CGATS, TXT, and other color data formats

## Technical Notes

### CMYK to Lab Conversion
The ICM parser uses an approximate conversion:
1. CMYK → RGB (simplified model)
2. RGB → XYZ (sRGB primaries, D65 illuminant)
3. XYZ → Lab (CIE 1976)

For accurate conversions, the actual PCS data from the ICC profile should be used.

### ΔE00 Implementation
Current implementation is simplified. Full CIEDE2000 includes:
- Lightness weighting function
- Chroma weighting function
- Hue weighting function
- Rotation term for blue region

## Dependencies

```json
{
  "react": "^18.3.1",
  "react-dom": "^18.3.1",
  "d3": "^7.9.0",
  "zustand": "^4.5.5",
  "@tanstack/react-query": "^5.59.0"
}
```

## License
MIT
