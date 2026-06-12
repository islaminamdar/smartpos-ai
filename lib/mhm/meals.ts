export type Meal = {
  id: string
  name: string
  emoji: string
  cuisine: string
  mealType: 'breakfast' | 'lunch' | 'dinner'
  calories: number
  protein: number
  carbs: number
  fat: number
  ingredients: string
  tags: string[]
  plans: string[]
  allergens: string[]
}

export const meals: Meal[] = [
  {
    id: 'dal-makhani',
    name: 'Dal Makhani + Brown Rice',
    emoji: '🍛',
    cuisine: 'Indian',
    mealType: 'lunch',
    calories: 420,
    protein: 22,
    carbs: 55,
    fat: 10,
    ingredients: 'Black lentils · Kidney beans · Tomato · Brown rice · Garam masala',
    tags: ['Weight Loss', 'Vegetarian', 'Halal', 'Heart-Healthy'],
    plans: ['weight-loss', 'heart-healthy'],
    allergens: ['Dairy'],
  },
  {
    id: 'chicken-biryani',
    name: 'Chicken Biryani (Light)',
    emoji: '🍚',
    cuisine: 'Indian',
    mealType: 'lunch',
    calories: 510,
    protein: 36,
    carbs: 54,
    fat: 12,
    ingredients: 'Halal chicken · Basmati rice · Saffron · Yogurt · Whole spice',
    tags: ['High Protein', 'Halal'],
    plans: ['high-protein', 'indian-tiffin'],
    allergens: ['Dairy'],
  },
  {
    id: 'chicken-khichdi',
    name: 'Chicken Khichdi (Diabetic)',
    emoji: '🥣',
    cuisine: 'Indian',
    mealType: 'dinner',
    calories: 410,
    protein: 30,
    carbs: 42,
    fat: 9,
    ingredients: 'Yellow moong dal · Brown rice · Halal chicken · Ghee 1 tsp · Cumin',
    tags: ['Diabetic-Friendly', 'High Protein', 'Halal'],
    plans: ['diabetic-friendly', 'high-protein'],
    allergens: ['Dairy'],
  },
  {
    id: 'paneer-bhurji',
    name: 'Paneer Bhurji + Multigrain Roti',
    emoji: '🧀',
    cuisine: 'Indian',
    mealType: 'dinner',
    calories: 460,
    protein: 28,
    carbs: 35,
    fat: 18,
    ingredients: 'Fresh paneer · Onion · Tomato · Multigrain roti · Mixed pepper',
    tags: ['Vegetarian', 'High Protein'],
    plans: ['high-protein', 'lean-balanced'],
    allergens: ['Dairy', 'Gluten'],
  },
  {
    id: 'butter-chicken-lite',
    name: 'Butter Chicken Lite + Multigrain Naan',
    emoji: '🍗',
    cuisine: 'Indian',
    mealType: 'dinner',
    calories: 520,
    protein: 34,
    carbs: 42,
    fat: 18,
    ingredients: 'Halal chicken · Tomato-cashew gravy · Yogurt · Multigrain naan · Fenugreek',
    tags: ['High Protein', 'Halal'],
    plans: ['high-protein', 'indian-tiffin'],
    allergens: ['Dairy', 'Gluten', 'Nuts'],
  },
  {
    id: 'rajma-rice',
    name: 'Rajma + Brown Rice',
    emoji: '🍚',
    cuisine: 'Indian',
    mealType: 'lunch',
    calories: 480,
    protein: 19,
    carbs: 64,
    fat: 11,
    ingredients: 'Red kidney beans · Tomato · Onion · Brown basmati rice · Ginger-garlic',
    tags: ['Vegetarian', 'Halal', 'Heart-Healthy'],
    plans: ['heart-healthy', 'lean-balanced'],
    allergens: [],
  },
  {
    id: 'grilled-salmon',
    name: 'Grilled Salmon + Quinoa',
    emoji: '🐟',
    cuisine: 'International',
    mealType: 'lunch',
    calories: 445,
    protein: 32,
    carbs: 38,
    fat: 14,
    ingredients: 'Atlantic salmon · Quinoa · Lemon · Dill · Olive oil 5ml',
    tags: ['Heart-Healthy', 'High Protein', 'Halal'],
    plans: ['heart-healthy', 'lean-balanced'],
    allergens: ['Fish'],
  },
  {
    id: 'chicken-shawarma-bowl',
    name: 'Chicken Shawarma Bowl',
    emoji: '🥗',
    cuisine: 'International',
    mealType: 'lunch',
    calories: 490,
    protein: 38,
    carbs: 44,
    fat: 13,
    ingredients: 'Halal chicken · Brown rice · Hummus · Pickled veg · Tahini drizzle',
    tags: ['High Protein', 'Halal'],
    plans: ['high-protein', 'lean-balanced'],
    allergens: ['Sesame'],
  },
]

export const mealFilters = [
  { id: 'all', label: 'All meals' },
  { id: 'weight-loss', label: 'Weight Loss' },
  { id: 'high-protein', label: 'High Protein' },
  { id: 'diabetic-friendly', label: 'Diabetic-Friendly' },
  { id: 'heart-healthy', label: 'Heart-Healthy' },
  { id: 'indian-tiffin', label: 'Indian Tiffin' },
] as const
